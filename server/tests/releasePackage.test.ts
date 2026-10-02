/**
 * The release package, and the one version that must run through all of it.
 *
 * THE PROPERTY THIS FILE PROTECTS: a release cannot claim two versions. The
 * installer, the payload metadata, Version.txt and the running application all
 * derive from package.json, and a test asserts they cannot disagree — because
 * 6.3c found exactly that defect in the backup manifest, where the nightly task
 * recorded "0.0.0" while the application reported 0.1.0. An operator comparing
 * those two numbers concludes the wrong thing and acts on it.
 *
 * The second property is that the release contains what an operator needs to
 * TRUST it: a checksum file naming a command that ships with Windows, so
 * verifying a download does not require installing anything first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_CONTENTS,
  RELEASE_METADATA_FILES,
  SHIPPED_RELEASE_CONTENTS,
  SETUP_EXE_NAME,
  buildChecksumsText,
  buildReadmeText,
  buildReleaseNotesTemplate,
  buildVersionText,
  versionMismatches,
  type ChecksumEntry,
} from '../src/installer/release';

const ENTRIES: ChecksumEntry[] = [
  { file: SETUP_EXE_NAME, sha256: 'A'.repeat(64), bytes: 314_572_800 },
  { file: 'Version.txt', sha256: 'B'.repeat(64), bytes: 96 },
];

/* ================================================================== */
/* What a release contains                                             */
/* ================================================================== */
describe('release contents', () => {
  it('leads with the installer an operator double-clicks', () => {
    expect(RELEASE_CONTENTS[0]).toBe(SETUP_EXE_NAME);
    expect(SETUP_EXE_NAME.endsWith('.exe')).toBe(true);
  });

  it('carries checksums, a version stamp, notes and a readme', () => {
    for (const file of ['Checksums.txt', 'Version.txt', 'ReleaseNotes.md', 'README.txt']) {
      expect(RELEASE_METADATA_FILES, file).toContain(file);
    }
  });

  it('claims no licence file, because this repository has none', () => {
    // Shipping an invented LICENSE would be a legal statement rather than a
    // packaging decision. Feature G's "if applicable" is doing real work.
    expect(RELEASE_CONTENTS).not.toContain('LICENSE');
    expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'LICENSE'))).toBe(false);
  });

  it('ships the metadata even when the executable is not built', () => {
    // KasSetup.exe is opt-in until IExpress reliably launches its bootstrap.
    // The checksums, version stamp and readme are not conditional on it.
    for (const file of RELEASE_METADATA_FILES) {
      expect(SHIPPED_RELEASE_CONTENTS, file).toContain(file);
    }
    expect(SHIPPED_RELEASE_CONTENTS).not.toContain(SETUP_EXE_NAME);
  });

  it('ships no development files', () => {
    for (const item of RELEASE_CONTENTS) {
      expect(item, item).not.toMatch(/node_modules|\.ts$|\.map$|tsconfig|\.test\./);
    }
  });
});

/* ================================================================== */
/* Checksums                                                           */
/* ================================================================== */
describe('the checksum file', () => {
  const text = buildChecksumsText(ENTRIES, '0.1.0');

  it('names a verification command that ships with Windows', () => {
    // An instruction to install a hashing tool first is an instruction nobody
    // follows, which makes the checksums decorative.
    expect(text).toContain('certutil -hashfile');
    expect(text).toContain(SETUP_EXE_NAME);
  });

  it('lists every hash beside its file and size', () => {
    expect(text).toContain(`${'A'.repeat(64)}  ${SETUP_EXE_NAME}`);
    expect(text).toContain('314572800 bytes');
  });

  it('states the version it belongs to', () => {
    expect(text).toContain('0.1.0');
  });

  it('ends with a newline, so appending never corrupts the last line', () => {
    expect(text.endsWith('\n')).toBe(true);
  });
});

/* ================================================================== */
/* Version stamp                                                       */
/* ================================================================== */
describe('Version.txt', () => {
  it('is machine-readable', () => {
    const text = buildVersionText('0.1.0', 'abc123', '2026-08-05T22:00:00.000Z');
    expect(text).toContain('version=0.1.0');
    expect(text).toContain('commit=abc123');
    expect(text).toContain('builtAt=2026-08-05T22:00:00.000Z');
  });

  it('says "unknown" rather than leaving the commit blank', () => {
    // A blank value reads as a parsing failure; "unknown" reads as a fact.
    expect(buildVersionText('0.1.0', null, 'x')).toContain('commit=unknown');
  });
});

/* ================================================================== */
/* Version consistency — the defect this exists to prevent             */
/* ================================================================== */
describe('one version everywhere', () => {
  const consistent = {
    packageJson: '0.1.0',
    releaseJson: '0.1.0',
    versionTxt: '0.1.0',
    runtime: '0.1.0',
  };

  it('passes when all four agree', () => {
    expect(versionMismatches(consistent)).toEqual([]);
  });

  it('catches the exact shape of the 6.3c defect', () => {
    // The nightly backup recorded "0.0.0" while the application reported
    // 0.1.0, because it read an environment variable npm sets and node does not.
    const problems = versionMismatches({ ...consistent, runtime: '0.0.0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('runtime');
    expect(problems[0]).toContain('0.0.0');
    expect(problems[0]).toContain('0.1.0');
  });

  it('reports every disagreement, not just the first', () => {
    const problems = versionMismatches({
      packageJson: '0.2.0',
      releaseJson: '0.1.0',
      versionTxt: '0.1.0',
      runtime: '0.1.0',
    });
    expect(problems).toHaveLength(3);
  });

  it('treats package.json as the source of truth', () => {
    const problems = versionMismatches({ ...consistent, packageJson: '9.9.9' });
    for (const problem of problems) expect(problem).toContain('9.9.9');
  });

  it('the real repository is self-consistent', () => {
    // Guards against the two package.json files drifting apart, which is what
    // would make the release version depend on which file was read.
    const root = path.resolve(__dirname, '..', '..');
    const rootVersion = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string })
      .version;
    const serverVersion = (
      JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8')) as { version: string }
    ).version;
    expect(serverVersion).toBe(rootVersion);
  });
});

/* ================================================================== */
/* The README an operator reads first                                  */
/* ================================================================== */
describe('README.txt', () => {
  const text = buildReadmeText('0.1.0');

  it('warns about the SmartScreen prompt before it happens', () => {
    // Unsigned software WILL be flagged. An operator who was not warned
    // reasonably assumes the download is malicious and stops.
    expect(text).toContain('Không rõ nhà phát hành');
    expect(text).toContain('Run anyway');
  });

  it('says what an upgrade preserves', () => {
    // Asserted per item rather than as one phrase: the sentence wraps, and a
    // contiguous-string check would fail on a line break that changes nothing.
    for (const kept of ['Cấu hình', 'ảnh xác nhận', 'nhật ký', 'bản sao lưu']) {
      expect(text, kept).toContain(kept);
    }
    expect(text).toContain('Cơ sở dữ liệu không bị đụng tới');
  });

  it('names the elevation step for starting with Windows', () => {
    expect(text).toContain('Run as administrator');
  });

  it('tells the operator how to check the install afterwards', () => {
    expect(text).toContain('--diagnose');
  });

  it('promises the support file carries no password', () => {
    expect(text).toContain('KHÔNG chứa mật khẩu');
  });

  it('states the prerequisites', () => {
    expect(text).toContain('Windows 10');
    expect(text).toContain('PostgreSQL 17');
  });
});

describe('ReleaseNotes.md', () => {
  it('is a template that says so, rather than inventing a changelog', () => {
    const notes = buildReleaseNotesTemplate('0.1.0', '2026-08-05T22:00:00.000Z');
    expect(notes).toContain('0.1.0');
    expect(notes).toContain('Chưa có ghi chú');
  });

  it('points at the checksums before the install step', () => {
    expect(buildReleaseNotesTemplate('0.1.0', 'x')).toContain('Checksums.txt');
  });
});
