import { z } from 'zod';
import type { DiscoveryEnvelope } from './discovery.ts';
import type { NativeLaunch, NativeTranscript } from './native-discovery.ts';
import { startNativeTask } from './native-discovery.ts';
import { initializeParams, loginCancelParams, loginStartParams } from './protocol.ts';

// Sign-in and sign-out of CrewKite's own Codex home, through the app-server's account methods.
// Codex keeps the sign-in in that home and refreshes the token itself, so CrewKite never reads
// or copies an auth file.

export type AccountStep = 'sign-in' | 'sign-out';
export type AccountResult = { success: boolean; error: string | null };

const MAX_LINE_BYTES = 65_536;
const loginStarted = z.object({
  loginId: z.string().min(1).max(200),
  authUrl: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'The sign-in page must use https.'),
});
const loginCompleted = z.object({
  loginId: z.string().max(200).nullable().optional(),
  success: z.boolean(),
  error: z.string().max(400).nullable().optional(),
});
const frame = z.union([
  z.object({ id: z.number().int(), result: z.unknown() }),
  z.object({ id: z.number().int(), error: z.object({ message: z.string().max(4096) }).loose() }),
  z.object({ method: z.string().max(200), params: z.unknown().optional() }),
]);
const encode = (...messages: object[]) =>
  new TextEncoder().encode(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);

/**
 * Initialize, then one account request. A sign-in answers with the browser page and ends when
 * the client says the browser came back. A server request has no answer here, so it ends the
 * step. Sign-out needs only the reply.
 */
export class CodexAccountTranscript implements NativeTranscript<AccountResult> {
  private readonly step: AccountStep;
  private readonly onUrl: (url: string) => void;
  private sent = 0;
  private awaiting = false;
  private bytes: number[] = [];
  private loginId: string | null = null;
  private result: AccountResult | null = null;
  private envelope: DiscoveryEnvelope = null;
  private count = 0;
  submitted = false;
  readonly refusedEnvelope = null;

  constructor(step: AccountStep, onUrl: (url: string) => void = () => {}) {
    this.step = step;
    this.onUrl = onUrl;
  }

  get complete() {
    return this.result !== null;
  }
  get pendingRequest() {
    if (this.sent === 0) return 'initialize' as const;
    if (this.result) return 'complete' as const;
    return this.step === 'sign-in' ? ('account/login/start' as const) : ('account/logout' as const);
  }
  get lastEnvelope() {
    return this.envelope;
  }
  get notifications() {
    return this.count;
  }

  next(): Uint8Array | null {
    if (this.awaiting || this.result) return null;
    this.awaiting = true;
    if (this.sent++ === 0)
      return encode({ id: 1, method: 'initialize', params: initializeParams() });
    this.submitted = true;
    return encode(
      { method: 'initialized' },
      this.step === 'sign-in'
        ? { id: 2, method: 'account/login/start', params: loginStartParams() }
        : { id: 2, method: 'account/logout' },
    );
  }

  interrupt(): Uint8Array | null {
    return this.loginId && !this.result
      ? encode({ id: 3, method: 'account/login/cancel', params: loginCancelParams(this.loginId) })
      : null;
  }

  push(bytes: Uint8Array) {
    for (const byte of bytes) {
      if (byte !== 10) {
        if (this.bytes.length === MAX_LINE_BYTES) throw new Error('A line exceeds its bound.');
        this.bytes.push(byte);
        continue;
      }
      const line = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.bytes));
      this.bytes = [];
      this.read(frame.parse(JSON.parse(line)));
    }
  }

  private read(value: z.infer<typeof frame>) {
    if ('method' in value) {
      if ('id' in value) throw new Error('The client asked for something a sign-in cannot answer.');
      this.envelope = 'notification';
      if (++this.count > 64) throw new Error('Too many notifications.');
      if (value.method === 'account/login/completed' && this.loginId) {
        const done = loginCompleted.parse(value.params);
        if (done.loginId && done.loginId !== this.loginId) return;
        this.result = { success: done.success, error: done.error ?? null };
      }
      return;
    }
    this.envelope = 'error' in value ? 'error' : 'response';
    if (value.id === 3) return;
    if (!this.awaiting || value.id !== this.sent) throw new Error('An answer came out of order.');
    this.awaiting = false;
    if ('error' in value) {
      if (value.id === 1) throw new Error('The client refused initialize.');
      this.result = { success: false, error: value.error.message.slice(0, 400) };
      return;
    }
    if (value.id === 1) return;
    if (this.step === 'sign-out') {
      this.result = { success: true, error: null };
      return;
    }
    const started = loginStarted.parse(value.result);
    this.loginId = started.loginId;
    // The answer is in. Nothing more is sent until the browser comes back.
    this.awaiting = true;
    this.onUrl(started.authUrl);
  }

  finish(): AccountResult {
    if (!this.result) throw new Error('The account step did not finish.');
    return this.result;
  }
}

/** A sign-in waits five minutes for the browser. Sign-out needs a few seconds. */
export const SIGN_IN_MS = 300_000;
export const SIGN_OUT_MS = 30_000;

export function startOpenAiAccountStep(
  launch: NativeLaunch,
  step: AccountStep,
  options: Omit<Parameters<typeof startNativeTask>[1], 'timeoutMs' | 'onSubmitted'> & {
    onUrl?: (url: string) => void;
  },
) {
  const { onUrl, ...rest } = options;
  return startNativeTask(
    launch,
    { ...rest, timeoutMs: step === 'sign-in' ? SIGN_IN_MS : SIGN_OUT_MS, onSubmitted: () => {} },
    () => new CodexAccountTranscript(step, onUrl),
  );
}
