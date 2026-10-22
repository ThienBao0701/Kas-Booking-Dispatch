/**
 * CLI: writes the metadata files that turn a built installer into a release.
 *
 *   node server/dist/scripts/releaseMetadata.js --release-dir=<dir> [--commit=<sha>]
 *
 * Called by Package-Kas.ps1 AFTER the installer executable exists, because the
 * checksums have to describe the real file. Kept in TypeScript rather than
 * inlined into the packager so the wording and the format are testable — and so
 * the version cannot be typed twice.
 *
 * ReleaseNotes.md is written only when absent: a release is often cut after
 * somebody has hand-written the notes, and an automated step that overwrote
 * them would be discovered exactly once, at the worst moment.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  RELEASE_METADATA_FILES,
  SETUP_EXE_NAME,
  buildChecksumsText,
  buildReadmeText,
  buildReleaseNotesTemplate,
  buildVersionText,
  type ChecksumEntry,
} from '../installer/release';
import { versionInfo } from '../production/version';

/* eslint-disable no-console */

function stringArg(name: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw?.slice(name.length + 3);
}

function sha256(file: string): ChecksumEntry {
  const buffer = fs.readFileSync(file);
  return {
    file: path.basename(file),
    sha256: createHash('sha256').update(buffer).digest('hex').toUpperCase(),
    bytes: buffer.byteLength,
  };
}

function main(): void {
  const releaseDir = stringArg('release-dir');
  if (!releaseDir) {
    console.error('Thiếu --release-dir=<thư mục>.');
    process.exitCode = 1;
    return;
  }

  const info = versionInfo();
  const version = stringArg('version') ?? info.appVersion;
  const commit = stringArg('commit') ?? info.gitCommit;
  const builtAt = new Date().toISOString();

  // Hash everything shipped EXCEPT the checksum file itself, which cannot
  // contain its own hash.
  const entries: ChecksumEntry[] = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== 'Checksums.txt')
    .map((e) => sha256(path.join(releaseDir, e.name)))
    // The installer first: it is the file anyone actually verifies.
    .sort((a, b) => (a.file === SETUP_EXE_NAME ? -1 : b.file === SETUP_EXE_NAME ? 1 : a.file.localeCompare(b.file)));

  fs.writeFileSync(path.join(releaseDir, 'Version.txt'), buildVersionText(version, commit, builtAt), 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'README.txt'), buildReadmeText(version), 'utf8');

  const notes = path.join(releaseDir, 'ReleaseNotes.md');
  if (!fs.existsSync(notes)) {
    fs.writeFileSync(notes, buildReleaseNotesTemplate(version, builtAt), 'utf8');
  }

  // Written last, so it can include the two files above.
  const withMetadata = [
    ...entries,
    ...['Version.txt', 'README.txt', 'ReleaseNotes.md']
      .filter((name) => !entries.some((e) => e.file === name))
      .map((name) => sha256(path.join(releaseDir, name))),
  ];
  fs.writeFileSync(
    path.join(releaseDir, 'Checksums.txt'),
    buildChecksumsText(withMetadata, version),
    'utf8',
  );

  console.log(`Đã ghi metadata bản phát hành ${version} vào ${releaseDir}`);
  for (const name of RELEASE_METADATA_FILES) console.log(`  ${name}`);
  const missing = fs.existsSync(path.join(releaseDir, SETUP_EXE_NAME)) ? null : SETUP_EXE_NAME;
  if (missing) console.log(`  (CHƯA có ${missing} — chỉ có gói thư mục)`);
}

if (require.main === module) main();
