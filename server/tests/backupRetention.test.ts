/**
 * Retention: which backups get deleted, and which never can be.
 *
 * THE PROPERTY THIS FILE PROTECTS: a retention policy must never be able to
 * leave the hotel with nothing. Deleting old backups is housekeeping; deleting
 * the last good one is the disaster the backups existed to prevent, arriving
 * from the direction nobody watches.
 *
 * The second property is about PARTIAL backups. A directory with no manifest is
 * either a backup being written right now, or the wreckage of one that failed.
 * Counting it toward the retention window would push a good backup out; deleting
 * it could destroy a backup mid-write. It is left alone, and it stays visible,
 * because a manifest-less directory is evidence that something went wrong and
 * that is worth an operator noticing.
 *
 * Filesystem, not mocks: this deletes directories, and the thing worth being
 * sure about is which ones are gone afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_MANIFEST_NAME,
  isCompleteBackup,
  listBackups,
  pruneBackups,
} from '../src/production/backup';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-retain-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Creates a backup directory. `complete` writes the manifest that finishes it. */
function makeBackup(name: string, complete = true): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'database.dump'), 'x');
  if (complete) fs.writeFileSync(path.join(dir, BACKUP_MANIFEST_NAME), '{}');
}

const present = (): string[] => fs.readdirSync(root).sort();

/** Six complete backups, oldest first by name — which is oldest by time. */
function sixBackups(): void {
  for (const day of ['01', '02', '03', '04', '05', '06']) {
    makeBackup(`backup-202608${day}T220000`);
  }
}

/* ================================================================== */
/* Listing                                                             */
/* ================================================================== */
describe('listing', () => {
  it('returns backups newest first', async () => {
    sixBackups();
    const listed = await listBackups(root);
    expect(listed[0]).toContain('06');
    expect(listed[listed.length - 1]).toContain('01');
  });

  it('ignores directories that are not backups', async () => {
    sixBackups();
    fs.mkdirSync(path.join(root, 'pre-restore-20260805'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(await listBackups(root)).toHaveLength(6);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await listBackups(path.join(root, 'nowhere'))).toEqual([]);
  });

  it('recognises a complete backup by its manifest', () => {
    makeBackup('backup-A', true);
    makeBackup('backup-B', false);
    expect(isCompleteBackup(root, 'backup-A')).toBe(true);
    expect(isCompleteBackup(root, 'backup-B')).toBe(false);
  });
});

/* ================================================================== */
/* Deleting                                                            */
/* ================================================================== */
describe('pruning', () => {
  it('keeps everything when retention is zero', async () => {
    sixBackups();
    expect(await pruneBackups(root, 0)).toEqual([]);
    expect(present()).toHaveLength(6);
  });

  it('keeps everything when there are fewer than the limit', async () => {
    sixBackups();
    expect(await pruneBackups(root, 30)).toEqual([]);
    expect(present()).toHaveLength(6);
  });

  it('deletes the oldest beyond the limit', async () => {
    sixBackups();
    const pruned = await pruneBackups(root, 2);
    expect(pruned).toHaveLength(4);
    expect(present()).toEqual([
      'backup-20260805T220000',
      'backup-20260806T220000',
    ]);
  });

  it('deletes the whole directory, not just the manifest', async () => {
    sixBackups();
    await pruneBackups(root, 1);
    expect(fs.existsSync(path.join(root, 'backup-20260801T220000'))).toBe(false);
  });
});

/* ================================================================== */
/* What it must never do                                               */
/* ================================================================== */
describe('the newest is never deleted', () => {
  it('keeps one even when asked to keep a negative number', async () => {
    // A retention of 0 or less means "keep everything" — it must never be read
    // as "keep none".
    sixBackups();
    expect(await pruneBackups(root, -5)).toEqual([]);
    expect(present()).toHaveLength(6);
  });

  it('never empties the directory, whatever the arithmetic says', async () => {
    sixBackups();
    await pruneBackups(root, 1);
    const left = present();
    expect(left).toHaveLength(1);
    expect(left[0]).toBe('backup-20260806T220000');
  });
});

describe('partial backups', () => {
  it('never deletes a backup that has no manifest yet', async () => {
    // It may be being written at this very moment.
    sixBackups();
    makeBackup('backup-20260807T220000', false);
    await pruneBackups(root, 1);
    expect(fs.existsSync(path.join(root, 'backup-20260807T220000'))).toBe(true);
  });

  it('does not let a partial backup push a good one out of the window', async () => {
    // The bug this prevents: an in-progress or failed directory counts toward
    // the limit, so a real backup is deleted to make room for wreckage.
    makeBackup('backup-20260801T220000');
    makeBackup('backup-20260802T220000');
    makeBackup('backup-20260803T220000', false); // failed run, newest by name
    await pruneBackups(root, 2);

    expect(fs.existsSync(path.join(root, 'backup-20260801T220000'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'backup-20260802T220000'))).toBe(true);
  });

  it('leaves the evidence of a failed backup for someone to find', async () => {
    makeBackup('backup-20260801T220000');
    makeBackup('backup-20260802T220000', false);
    await pruneBackups(root, 1);
    expect(fs.existsSync(path.join(root, 'backup-20260802T220000'))).toBe(true);
  });

  it('counts only complete backups when deciding what is surplus', async () => {
    sixBackups();
    makeBackup('backup-20260800T000000', false);
    const pruned = await pruneBackups(root, 6);
    // Six complete backups and a limit of six: nothing is surplus.
    expect(pruned).toEqual([]);
  });
});
