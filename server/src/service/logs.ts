/**
 * Production log files, with a bound on how large they may get.
 *
 * WHY THIS IS NOT A LOGGING LIBRARY. Kas needs five append-only text files and
 * a size cap. A logging framework brings transports, levels, formatters and a
 * dependency to keep patched, and would still need this rotation logic written
 * on top of it. This is thirty lines and it is testable.
 *
 * WHY ROTATION IS NOT OPTIONAL. The previous launcher appended to one
 * `launcher.log` forever. On a machine that starts at boot every day and is
 * never looked at, "forever" is the failure: the file grows until the disk it
 * shares with PostgreSQL runs out, and the first symptom is the hotel unable to
 * dispatch. A bounded log loses old lines; an unbounded one eventually loses
 * the database.
 *
 * NOTHING SECRET IS EVER PASSED IN. The runner reports the PRESENCE of
 * DATABASE_URL, never its value, and the server's own output is already written
 * to be safe to display — that is a property of the server's log lines, checked
 * where they are written, not something this module can enforce.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LOG_FILES,
  MAX_LOG_GENERATIONS,
  expiredGeneration,
  rotationPlan,
  shouldRotate,
  type LogName,
} from './plan';

/** Writes to one bounded file. */
export class LogFile {
  private readonly filePath: string;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly generations = MAX_LOG_GENERATIONS,
  ) {
    this.filePath = path.join(dir, name);
  }

  get path(): string {
    return this.filePath;
  }

  /** Current size in bytes; 0 when the file does not exist yet. */
  size(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Renames the current file out of the way and drops the oldest generation.
   *
   * Every step is individually tolerant of a missing file: rotation runs on a
   * live system where a generation may have been deleted by hand, and a
   * half-rotated set of logs is far better than an exception that stops the
   * runner from starting.
   */
  rotate(): void {
    try {
      fs.rmSync(path.join(this.dir, expiredGeneration(this.name, this.generations)), { force: true });
    } catch {
      // An undeletable oldest generation costs disk, not correctness.
    }
    for (const { from, to } of rotationPlan(this.name, this.generations)) {
      try {
        fs.renameSync(path.join(this.dir, from), path.join(this.dir, to));
      } catch {
        // Missing generation — nothing to move. Expected on the first rotations.
      }
    }
  }

  /** Appends one line, rotating first if this write would exceed the cap. */
  append(line: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (shouldRotate(this.size())) this.rotate();
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
    } catch {
      // A log that cannot be written must never stop the app from running.
      // The startup validation already reported an unwritable log directory as
      // a problem; past that point, serving guests wins over recording it.
    }
  }
}

/** The five production logs, opened together. */
export type LogSet = Record<LogName, LogFile>;

export function openLogs(dir: string, generations = MAX_LOG_GENERATIONS): LogSet {
  const entries = Object.entries(LOG_FILES) as [LogName, string][];
  return Object.fromEntries(
    entries.map(([key, file]) => [key, new LogFile(dir, file, generations)]),
  ) as LogSet;
}

/** An ISO-stamped line, the format every one of these files uses. */
export function stamp(line: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] ${line}`;
}
