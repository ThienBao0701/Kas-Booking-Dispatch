/**
 * Stopping and starting the real Kas, for the restore orchestrator.
 *
 * Thin on purpose: every decision lives in `safeRestore`, and this is the part
 * that touches the operating system. It speaks to the 6.3a runner rather than
 * to node directly, so a restore stops the application the same way an operator
 * does and the server's own graceful shutdown runs.
 *
 * START IS FIRE-AND-FORGET. `KasService.cmd` blocks for as long as Kas runs, so
 * it is spawned detached and the caller waits on HEALTH instead — which is the
 * honest signal anyway: a process that exists is not an application that works.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { requestStop, waitForHealthy } from '../service/control';
import type { AppControl } from './safeRestore';

/** Repository root, from `server/src/production/` or `server/dist/production/`. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface AppControlOptions {
  port: number;
  /** How long to allow a graceful stop to complete before continuing. */
  stopSettleMs?: number;
  root?: string;
}

export function createAppControl(options: AppControlOptions): AppControl {
  const root = options.root ?? REPO_ROOT;
  const settle = options.stopSettleMs ?? 5000;

  return {
    async stop(): Promise<boolean> {
      const acknowledged = await requestStop(options.port);
      // A stop is asynchronous: the runner acknowledges, then finishes in-flight
      // requests and disconnects Prisma. Restoring on top of a database the old
      // process still holds a connection to is how a restore fails obscurely.
      if (acknowledged) await new Promise((resolve) => setTimeout(resolve, settle));
      return acknowledged;
    },

    async start(): Promise<void> {
      const child = spawn('cmd', ['/c', path.join(root, 'KasService.cmd')], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    },

    waitHealthy: (timeoutMs: number) => waitForHealthy(options.port, timeoutMs),
  };
}
