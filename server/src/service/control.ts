/**
 * Talking to a running Kas runner from another process.
 *
 * Extracted from `runner.ts` in 6.3b because the restore tool needs exactly the
 * same two operations — stop the application, then ask whether it came back —
 * and a second implementation of either would be a second thing to keep
 * correct. The runner listens; this is what the runner, the `--stop` command
 * and the restore orchestrator all speak.
 *
 * WHY A NAMED PIPE AND NOT A SIGNAL. Windows has no POSIX signals: a
 * `kill('SIGTERM')` from outside calls TerminateProcess and the server's
 * graceful shutdown never runs, which during a restore would mean cutting a
 * write in half at the exact moment the data matters most.
 */
import net from 'node:net';

/** Per-port, so two Kas instances on one machine cannot collide. */
export function controlPipe(port: number): string {
  return `\\\\.\\pipe\\kas-runner-${port}`;
}

/** How long to wait for a runner to acknowledge a stop request. */
const STOP_TIMEOUT_MS = 5000;

/**
 * Asks a running runner to shut down. Resolves true when one answered.
 *
 * False means "nothing was listening", which is not an error: stopping an
 * application that is already stopped is exactly what a restore wants.
 */
export async function requestStop(port: number, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(controlPipe(port));
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write('stop'));
    socket.once('data', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** What /api/health said, or null when it did not answer at all. */
export interface HealthReading {
  databaseOk: boolean;
  /** The HTTP status, kept so a 503 can be told apart from no answer. */
  status: number;
}

/**
 * Reads the health endpoint.
 *
 * 503 counts as an ANSWER, not a failure to answer: it is Kas reporting that
 * its database is unreachable, which is a different fault from Kas being down
 * and needs a different response.
 */
export async function readHealth(
  port: number,
  timeoutMs = 1500,
  origin = `http://localhost:${port}`,
): Promise<HealthReading | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${origin}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.status !== 200 && response.status !== 503) return null;
    const body = (await response.json()) as { database?: { connected?: boolean } };
    return { databaseOk: body.database?.connected === true, status: response.status };
  } catch {
    return null;
  }
}

/** Polls until the app is fully healthy, or gives up. */
export async function waitForHealthy(
  port: number,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reading = await readHealth(port, 1000);
    // Fully healthy means the database answered too — after a restore, an app
    // that is up but cannot reach its data is the failure being tested for.
    if (reading?.status === 200 && reading.databaseOk) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
