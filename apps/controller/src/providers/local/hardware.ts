import { execFile } from 'node:child_process';
import { arch, platform } from 'node:os';
import { z } from 'zod';

// On Apple Silicon the GPU core count is only in the system report, so the controller reads it
// once per process. The read is bounded by time and bytes and never touches the network. Any
// report it cannot read gives nulls, and the Local card shows what `os` already knows.

export type GpuFacts = { gpuCores: number | null; gpuModel: string | null };
export type ReportRun = (
  command: string,
  args: readonly string[],
  limits: { timeoutMs: number; maxBytes: number },
) => Promise<string>;

const REPORT = '/usr/sbin/system_profiler';
const REPORT_MS = 5000;
const REPORT_BYTES = 256 * 1024;
const UNKNOWN: GpuFacts = { gpuCores: null, gpuModel: null };

const CoresSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\s*\d{1,4}\s*$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(4096));
const ModelSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      value.isWellFormed() &&
      !/\p{Cc}/u.test(value) &&
      new TextEncoder().encode(value).length <= 200,
  );
// Only the first entry is read, so later entries can take any shape.
const ReportSchema = z.object({ SPDisplaysDataType: z.array(z.unknown()).min(1) });
const EntrySchema = z.object({
  sppci_cores: CoresSchema.optional().catch(undefined),
  sppci_model: ModelSchema.optional().catch(undefined),
});

/** Cores and chip name from the first display entry of `system_profiler SPDisplaysDataType -json`. */
export function readGpuReport(text: string): GpuFacts {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return UNKNOWN;
  }
  const report = ReportSchema.safeParse(value);
  const first = report.success ? EntrySchema.safeParse(report.data.SPDisplaysDataType[0]) : null;
  if (!first?.success) return UNKNOWN;
  return { gpuCores: first.data.sppci_cores ?? null, gpuModel: first.data.sppci_model ?? null };
}

const runReport: ReportRun = (command, args, limits) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxBytes,
        encoding: 'utf8',
        env: { PATH: '/usr/sbin:/usr/bin:/bin', LC_ALL: 'C' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** Null off Apple Silicon, where the report has no core count to give. */
export async function probeGpu(
  run: ReportRun = runReport,
  host = { platform: platform(), arch: arch() },
): Promise<GpuFacts | null> {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return null;
  try {
    return readGpuReport(
      await run(REPORT, ['SPDisplaysDataType', '-json'], {
        timeoutMs: REPORT_MS,
        maxBytes: REPORT_BYTES,
      }),
    );
  } catch {
    return UNKNOWN;
  }
}

let probing = false;
let facts: GpuFacts | null | undefined;

/** Starts the probe once. The controller process calls it at launch; tests never do. */
export function startGpuProbe() {
  if (probing) return;
  probing = true;
  void probeGpu().then((value) => {
    facts = value;
  });
}

/**
 * The cached probe result. Undefined until the launch probe has answered, and always in a
 * process that never started it, so the caller leaves the GPU fields out.
 */
export function gpuFacts(): GpuFacts | null | undefined {
  return facts;
}
