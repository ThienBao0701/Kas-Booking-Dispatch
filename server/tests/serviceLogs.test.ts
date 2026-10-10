/**
 * The production log files, against a real filesystem.
 *
 * THE PROPERTY THIS FILE PROTECTS: the logs cannot fill the disk. The previous
 * launcher appended to one file forever. On a machine that starts at boot every
 * day and is never looked at, "forever" is the failure mode — the file grows
 * until the volume it shares with PostgreSQL runs out, and the first symptom is
 * a hotel that cannot dispatch.
 *
 * A temp directory is used rather than mocked `fs`: rotation is a sequence of
 * renames whose ORDER is the whole correctness argument, and a mock would
 * happily accept an order that destroys a generation on a real disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogFile, openLogs, stamp } from '../src/service/logs';
import { LOG_FILES, MAX_LOG_BYTES } from '../src/service/plan';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-logs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const exists = (name: string) => fs.existsSync(path.join(dir, name));

/** Fills a log past the rotation cap. */
function fill(log: LogFile, bytes = MAX_LOG_BYTES): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(log.path, 'x'.repeat(bytes), 'utf8');
}

/* ================================================================== */
/* Writing                                                            */
/* ================================================================== */
describe('writing', () => {
  it('creates the directory and the file on first write', () => {
    const nested = path.join(dir, 'deeper', 'still');
    new LogFile(nested, 'service.log').append('một dòng');
    expect(fs.readFileSync(path.join(nested, 'service.log'), 'utf8')).toBe('một dòng\n');
  });

  it('appends rather than replacing', () => {
    const log = new LogFile(dir, 'service.log');
    log.append('đầu tiên');
    log.append('thứ hai');
    expect(read('service.log')).toBe('đầu tiên\nthứ hai\n');
  });

  it('never throws when the directory cannot be written', () => {
    // A log that cannot be written must not stop the hotel from dispatching.
    // (A file where the directory should be is the portable way to make a
    // directory creation fail on Windows and POSIX alike.)
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory', 'utf8');
    expect(() => new LogFile(path.join(blocked, 'inner'), 'service.log').append('x')).not.toThrow();
  });

  it('reports a missing file as empty rather than failing', () => {
    expect(new LogFile(dir, 'never-written.log').size()).toBe(0);
  });
});

/* ================================================================== */
/* Rotation                                                           */
/* ================================================================== */
describe('rotation', () => {
  it('does not rotate a small file', () => {
    const log = new LogFile(dir, 'server.log');
    log.append('nhỏ');
    log.append('vẫn nhỏ');
    expect(exists('server.1.log')).toBe(false);
  });

  it('rotates once the file reaches the cap', () => {
    const log = new LogFile(dir, 'server.log');
    fill(log);
    log.append('dòng sau khi xoay vòng');

    expect(exists('server.1.log')).toBe(true);
    // The new file holds only what was written after the rotation.
    expect(read('server.log')).toBe('dòng sau khi xoay vòng\n');
    expect(read('server.1.log').length).toBe(MAX_LOG_BYTES);
  });

  it('preserves the older generation instead of overwriting it', () => {
    // THE ORDERING BUG THIS CATCHES: rotating server.log onto server.1.log
    // before moving server.1.log out of the way destroys the previous run,
    // which is usually where the cause of the current fault is.
    const log = new LogFile(dir, 'server.log');
    fs.writeFileSync(path.join(dir, 'server.1.log'), 'lần chạy trước', 'utf8');
    fill(log);
    log.append('mới');

    expect(read('server.2.log')).toBe('lần chạy trước');
  });

  it('keeps exactly the configured number of generations', () => {
    const log = new LogFile(dir, 'server.log', 3);
    for (let i = 0; i < 5; i += 1) {
      fill(log);
      log.append(`lần ${i}`);
    }

    expect(exists('server.1.log')).toBe(true);
    expect(exists('server.2.log')).toBe(true);
    expect(exists('server.3.log')).toBe(true);
    // Bounded: the fourth generation never appears, however many rotations run.
    expect(exists('server.4.log')).toBe(false);
  });

  it('bounds total log size no matter how much is written', () => {
    // The property the disk cares about, measured rather than reasoned about.
    const generations = 3;
    const log = new LogFile(dir, 'server.log', generations);
    for (let i = 0; i < 8; i += 1) {
      fill(log);
      log.append('x');
    }

    const total = fs
      .readdirSync(dir)
      .map((f) => fs.statSync(path.join(dir, f)).size)
      .reduce((sum, size) => sum + size, 0);
    expect(total).toBeLessThanOrEqual(MAX_LOG_BYTES * (generations + 1));
  });

  it('survives a generation deleted by hand', () => {
    // Operators do tidy up log directories. A missing generation must not stop
    // rotation, or the logs stop being written the day someone cleans up.
    const log = new LogFile(dir, 'server.log', 3);
    fill(log);
    log.append('a');
    fs.rmSync(path.join(dir, 'server.1.log'));
    fill(log);
    expect(() => log.append('b')).not.toThrow();
    expect(read('server.log')).toBe('b\n');
  });
});

/* ================================================================== */
/* The set                                                            */
/* ================================================================== */
describe('the five logs', () => {
  it('opens each one in the same directory', () => {
    const logs = openLogs(dir);
    for (const [key, file] of Object.entries(LOG_FILES)) {
      logs[key as keyof typeof LOG_FILES].append('x');
      expect(exists(file), file).toBe(true);
    }
  });

  it('keeps them independent, so one rotation cannot lose another', () => {
    const logs = openLogs(dir, 2);
    logs.error.append('lỗi quan trọng');
    fill(logs.server);
    logs.server.append('sau xoay vòng');

    // The error log is untouched by the server log's rotation.
    expect(read('error.log')).toBe('lỗi quan trọng\n');
    expect(exists('error.1.log')).toBe(false);
  });

  it('timestamps every line so two logs can be read side by side', () => {
    const line = stamp('khởi động', new Date('2026-08-05T01:02:03.000Z'));
    expect(line).toBe('[2026-08-05T01:02:03.000Z] khởi động');
  });
});
