import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** The part of Electron's safeStorage that the vault uses, so a test can supply its own. */
export type SecretStorage = {
  isEncryptionAvailable(): boolean;
  /** Linux names its backend; other systems may not have the call. */
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(blob: Buffer): string;
};
export type LocalTokenCapability = {
  available: boolean;
  /** Present when available is false. Shown on the Local card. */
  reason?: string;
  /** True when a blob exists for the current endpoint. */
  remembered: boolean;
};
export type LocalTokenMode = 'token' | 'none';

export const UNAVAILABLE_REASON =
  'This device has no keychain that encrypts stored secrets, so the token is asked for each launch.';
const MAX_TOKEN_BYTES = 4096;

/**
 * basic_text is a fixed key, so a blob under it is a plain file. unknown means the backend is not
 * chosen yet. Any other name, and a system that has no such call, counts as real encryption when
 * safeStorage says it can encrypt.
 */
export function storageUsable(storage: SecretStorage): boolean {
  try {
    if (!storage.isEncryptionAvailable()) return false;
    const backend = storage.getSelectedStorageBackend?.();
    return backend !== 'basic_text' && backend !== 'unknown';
  } catch {
    return false;
  }
}

type Stored = { version: 1; endpoint: string; blob: string };

/**
 * The remembered Local token: one encrypted blob in the desktop profile, bound to one endpoint.
 * Nothing here returns the token to the renderer; the bridge passes it to the controller.
 */
export class LocalTokenVault {
  private readonly path: string;
  private readonly storage: SecretStorage;
  constructor(profile: string, storage: SecretStorage) {
    this.path = join(profile, 'local-token.json');
    this.storage = storage;
  }

  private load(): Stored | null {
    try {
      const text = readFileSync(this.path, { encoding: 'utf8' });
      if (text.length > 16384) return null;
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') return null;
      const { version, endpoint, blob } = value as Record<string, unknown>;
      return version === 1 && typeof endpoint === 'string' && typeof blob === 'string'
        ? { version, endpoint, blob }
        : null;
    } catch {
      return null;
    }
  }

  /** Deletes the blob unless it belongs to this endpoint in token mode. */
  reconcile(endpoint: string | null, mode: LocalTokenMode | undefined) {
    const record = this.load();
    if (!record || (record.endpoint === endpoint && mode === 'token')) return;
    this.forget();
  }

  capability(endpoint: string | null, mode: LocalTokenMode | undefined): LocalTokenCapability {
    this.reconcile(endpoint, mode);
    const available = storageUsable(this.storage);
    return {
      available,
      ...(available ? {} : { reason: UNAVAILABLE_REASON }),
      remembered: available && this.load()?.endpoint === endpoint,
    };
  }

  remember(endpoint: string, mode: LocalTokenMode | undefined, token: string) {
    if (!storageUsable(this.storage)) throw new Error(UNAVAILABLE_REASON);
    if (mode !== 'token') throw new Error('Only a token connection can be remembered.');
    if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES)
      throw new Error('The token is not valid.');
    const blob = this.storage.encryptString(token).toString('base64');
    const next = `${this.path}.next`;
    const file = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try {
      writeSync(file, JSON.stringify({ version: 1, endpoint, blob }));
    } finally {
      closeSync(file);
    }
    renameSync(next, this.path);
  }

  /** The token for this endpoint, or null. A blob that no longer decrypts is deleted. */
  read(endpoint: string | null, mode: LocalTokenMode | undefined): string | null {
    this.reconcile(endpoint, mode);
    const record = this.load();
    if (!record || record.endpoint !== endpoint || !storageUsable(this.storage)) return null;
    try {
      return this.storage.decryptString(Buffer.from(record.blob, 'base64'));
    } catch {
      this.forget();
      return null;
    }
  }

  forget() {
    rmSync(this.path, { force: true });
  }
}

/**
 * How the controller gives up and takes back the token it holds in memory. The controller owns
 * the token window and its helper, so main needs a controller command for each direction. While
 * none exists, supported is false and the option reports itself unavailable.
 */
export type LocalTokenPort = {
  supported: boolean;
  /** The token the controller holds for the current connection, or null. */
  take(): Promise<string | null>;
  /** Hands a remembered token to the controller for the current connection. */
  give(token: string): Promise<boolean>;
};
export const unsupportedPort: LocalTokenPort = {
  supported: false,
  take: async () => null,
  give: async () => false,
};
export const PORT_REASON = 'This controller cannot hand the token to the desktop yet.';
export type LocalSetupView = {
  endpoint: string | null;
  authMode?: LocalTokenMode;
  secretConfigured: boolean;
  revision: number;
};

/** The three renderer calls, built on the vault, the controller port and the current setup. */
export class RememberedLocalToken {
  private readonly vault: LocalTokenVault;
  private readonly port: LocalTokenPort;
  private readonly readSetup: () => Promise<LocalSetupView | null>;
  private readonly disconnect: (revision: number) => Promise<void>;
  constructor(
    vault: LocalTokenVault,
    port: LocalTokenPort,
    readSetup: () => Promise<LocalSetupView | null>,
    disconnect: (revision: number) => Promise<void>,
  ) {
    this.vault = vault;
    this.port = port;
    this.readSetup = readSetup;
    this.disconnect = disconnect;
  }

  async status(): Promise<LocalTokenCapability> {
    const setup = await this.readSetup();
    const found = this.vault.capability(setup?.endpoint ?? null, setup?.authMode ?? 'token');
    return found.available && !this.port.supported
      ? { available: false, reason: PORT_REASON, remembered: false }
      : found;
  }

  async remember(): Promise<LocalTokenCapability> {
    const setup = await this.readSetup();
    const found = await this.status();
    if (!found.available || !setup?.endpoint)
      throw new Error(found.reason ?? 'Set up Local first.');
    if (!setup.secretConfigured) throw new Error('Connect with a token before remembering it.');
    const token = await this.port.take();
    if (!token) throw new Error('The controller has no token to remember.');
    this.vault.remember(setup.endpoint, setup.authMode ?? 'token', token);
    return this.status();
  }

  async forget(): Promise<LocalTokenCapability> {
    const setup = await this.readSetup();
    this.vault.forget();
    if (setup?.secretConfigured) await this.disconnect(setup.revision);
    return this.status();
  }

  /** True when the controller now holds the remembered token and no token window is needed. */
  async supply(): Promise<boolean> {
    if (!this.port.supported) return false;
    const setup = await this.readSetup();
    const token = this.vault.read(setup?.endpoint ?? null, setup?.authMode ?? 'token');
    return token ? this.port.give(token) : false;
  }

  /** Deletes the blob after a changed endpoint or mode. */
  async reconcile() {
    const setup = await this.readSetup();
    this.vault.reconcile(setup?.endpoint ?? null, setup?.authMode ?? 'token');
  }
}
