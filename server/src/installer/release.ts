/**
 * What a release folder contains, and how its metadata is written.
 *
 * The packager is PowerShell — it has to be, since it drives npm, IExpress and
 * the filesystem — but the DECISIONS about what a release is belong here, in a
 * module that can be tested. That split is the same one used for the installer
 * plan, and for the same reason: a release that quietly stops containing its
 * checksums is not something anyone notices until they need them.
 *
 * ONE VERSION, EVERYWHERE. `package.json` is the source; the packager writes it
 * into `Version.txt` and `kas-release.json`, the runtime reads it through
 * `production/version.ts`, and the backup manifest records it. A test asserts
 * they cannot disagree — a release whose installer claims one version while the
 * application reports another is how an operator ends up "upgrading" to the
 * build they already had.
 */

/** The single-file installer an operator double-clicks. */
export const SETUP_EXE_NAME = 'KasSetup.exe';

/** Metadata files that sit beside it in the release folder. */
export const RELEASE_METADATA_FILES: readonly string[] = [
  'Checksums.txt',
  'Version.txt',
  'ReleaseNotes.md',
  'README.txt',
];

/**
 * Everything a release folder must contain before it is handed to anyone.
 *
 * A LICENSE is deliberately absent: this repository has no licence file, and
 * inventing one would be a legal statement rather than a packaging decision.
 * Feature G's "if applicable" is doing real work there.
 */
export const RELEASE_CONTENTS: readonly string[] = [SETUP_EXE_NAME, ...RELEASE_METADATA_FILES];

/**
 * What a release actually ships TODAY.
 *
 * KasSetup.exe is built only behind `-BuildSetupExe`. It compiles, and its
 * payload installs correctly when the bootstrap inside it is run directly — but
 * IExpress does not reliably launch that bootstrap, and every attempted form
 * returned success while installing nothing. An installer that reports success
 * and does nothing is worse than no installer, so until that is understood the
 * shipped release is the staged folder plus Install-Kas.cmd, with these files
 * beside it.
 */
export const SHIPPED_RELEASE_CONTENTS: readonly string[] = [...RELEASE_METADATA_FILES];

/** One file's integrity record. */
export interface ChecksumEntry {
  file: string;
  sha256: string;
  bytes: number;
}

/**
 * The checksum file, in the format `certutil` and `Get-FileHash` both produce.
 *
 * Written so an operator can verify a download WITHOUT installing anything:
 * `certutil -hashfile KasSetup.exe SHA256` ships with Windows, and the
 * instruction is in the file itself rather than in a document they would have
 * to find first.
 */
export function buildChecksumsText(entries: readonly ChecksumEntry[], version: string): string {
  const lines = [
    `Kas ${version} — SHA-256`,
    '',
    'Kiểm tra trước khi cài (lệnh có sẵn trong Windows):',
    `    certutil -hashfile ${SETUP_EXE_NAME} SHA256`,
    '',
    'Giá trị phải khớp chính xác với dòng tương ứng bên dưới.',
    '',
  ];
  for (const entry of entries) {
    lines.push(`${entry.sha256}  ${entry.file}  (${entry.bytes} bytes)`);
  }
  return `${lines.join('\n')}\n`;
}

/** The one-line version stamp, kept machine-readable on purpose. */
export function buildVersionText(version: string, commit: string | null, builtAt: string): string {
  return [
    `version=${version}`,
    `commit=${commit ?? 'unknown'}`,
    `builtAt=${builtAt}`,
    '',
  ].join('\n');
}

/**
 * The README an operator reads before running anything.
 *
 * Deliberately short and in Vietnamese: it is read by the person standing at
 * the hotel's PC, not by a developer. Everything beyond installing points at
 * the fuller guides rather than being repeated here, because a README that
 * duplicates the documentation is a README that will disagree with it.
 */
export function buildReadmeText(version: string): string {
  return `Kas ${version} — Trung tâm điều phối đặt phòng
===============================================

CÀI ĐẶT

  1. Giải nén TOÀN BỘ thư mục nhận được.
  2. Nhấn đúp Install-Kas.cmd.
  3. Windows sẽ cảnh báo "Không rõ nhà phát hành" — phần mềm này chưa được ký
     số. Chọn "More info" rồi "Run anyway".
  4. Làm theo các bước trên màn hình.
  5. Mở tệp .env trong thư mục cài đặt và điền DATABASE_URL.
  6. Nhấn đúp biểu tượng Kas trên Desktop.

  Muốn Kas TỰ CHẠY mỗi khi bật máy: nhấn chuột phải Install-Kas.cmd và chọn
  "Run as administrator". Không có quyền đó thì Kas vẫn chạy bình thường, chỉ là
  phải nhấn đúp biểu tượng sau mỗi lần khởi động máy.

YÊU CẦU

  - Windows 10 trở lên
  - Node.js 22 trở lên (https://nodejs.org) — trừ khi bản này đã kèm sẵn
  - PostgreSQL 17
  - 1 GB trống

KIỂM TRA SAU KHI CÀI

  Kas.cmd --diagnose      kiểm tra toàn bộ hệ thống
  Kas.cmd --version       phiên bản đang chạy
  Kas.cmd --help          danh sách lệnh

NÂNG CẤP

  Chạy lại Install-Kas.cmd từ bản mới. Cấu hình, ảnh xác nhận, nhật ký và các
  bản sao lưu đều được giữ nguyên. Cơ sở dữ liệu không bị đụng tới.

GỠ CÀI ĐẶT

  Settings > Apps > Kas Booking Dispatch. Mặc định giữ lại dữ liệu của bạn.

TÀI LIỆU

  docs/installation.md   cài đặt, nâng cấp, gỡ cài đặt
  docs/launcher.md       mọi lệnh vận hành
  docs/backup-restore.md sao lưu và khôi phục

HỖ TRỢ

  Chạy Kas.cmd --diagnose và gửi kèm logs\\deployment-report.json.
  Tệp đó KHÔNG chứa mật khẩu.
`;
}

/** The skeleton written when a release has no hand-authored notes. */
export function buildReleaseNotesTemplate(version: string, builtAt: string): string {
  return `# Kas ${version}

Phát hành: ${builtAt}

## Cài đặt

Nhấn đúp \`${SETUP_EXE_NAME}\`. Xem \`README.txt\`.

## Thay đổi

_Chưa có ghi chú cho bản này._

Kiểm tra toàn vẹn gói cài đặt bằng \`Checksums.txt\` trước khi chạy.
`;
}

/* ------------------------------------------------------------------ */
/* Version consistency                                                 */
/* ------------------------------------------------------------------ */

/** Every place a version appears in a built release. */
export interface VersionSources {
  /** package.json — the source everything else derives from. */
  packageJson: string;
  /** kas-release.json inside the payload. */
  releaseJson: string;
  /** Version.txt in the release folder. */
  versionTxt: string;
  /** What the installed application reports. */
  runtime: string;
}

/**
 * Are all four the same string?
 *
 * Returns the mismatches rather than a boolean, because "they disagree" is not
 * actionable and "Version.txt says 0.1.0 but the runtime says 0.0.0" is — that
 * being the exact shape of the defect found in 6.3c.
 */
export function versionMismatches(sources: VersionSources): string[] {
  const expected = sources.packageJson;
  const problems: string[] = [];
  const check = (name: string, value: string): void => {
    if (value !== expected) problems.push(`${name} = "${value}" nhưng package.json = "${expected}"`);
  };
  check('kas-release.json', sources.releaseJson);
  check('Version.txt', sources.versionTxt);
  check('runtime', sources.runtime);
  return problems;
}
