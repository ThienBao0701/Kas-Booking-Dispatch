/**
 * One place that knows what is running.
 *
 * THE DEFECT THIS REPLACES: the backup manifest read
 * `process.env.npm_package_version`, which npm sets and `node` does not. Every
 * backup taken by the nightly scheduled task — which runs node directly — was
 * therefore stamped `appVersion: "0.0.0"`. A backup that misreports its own
 * version is worse than one that omits it: an operator restoring after an
 * upgrade would compare "0.0.0" against the running build and conclude the
 * archive was ancient.
 *
 * So the version is read from package.json on disk, which is true however the
 * process was started, and every caller — the CLI, the logs, the manifest, the
 * deployment report — reads it from here.
 *
 * Resolved ONCE and cached: this is asked for on every startup line and in
 * every report, and re-reading three files each time would be pointless work
 * for a value that cannot change while the process lives.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface VersionInfo {
  /** From package.json. Never a guess. */
  appVersion: string;
  /**
   * The deployed commit, from APP_RELEASE_REF or the git checkout. Null when
   * neither is available — an installed copy has no .git directory, and
   * inventing a commit would make a report look authoritative when it is not.
   */
  gitCommit: string | null;
  /** When the running server bundle was built, from its mtime. */
  buildDate: string | null;
  /** NODE_ENV as the process actually sees it. */
  environment: string;
  nodeVersion: string;
}

/** Repository root, from `server/src/production/` or `server/dist/production/`. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readAppVersion(root: string): string {
  for (const candidate of [path.join(root, 'package.json'), path.join(root, 'server', 'package.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    } catch {
      // Try the next one. A missing package.json is possible in a trimmed
      // install; it is not a reason to fail.
    }
  }
  return 'unknown';
}

/**
 * Where the git metadata actually lives.
 *
 * `.git` is a DIRECTORY in an ordinary clone and a FILE containing
 * `gitdir: <path>` in a linked worktree or a submodule. This repository is
 * checked out as a worktree, which is how the naive version of this function
 * was caught reporting "no commit" on a machine that plainly had one.
 */
function resolveGitDir(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    if (!pointer.startsWith('gitdir:')) return null;
    const target = pointer.slice('gitdir:'.length).trim();
    return path.isAbsolute(target) ? target : path.resolve(root, target);
  } catch {
    return null;
  }
}

/** Looks a ref up in packed-refs, which is where git puts it after `gc`. */
function readPackedRef(gitDir: string, ref: string): string | null {
  for (const candidate of [gitDir, commonDir(gitDir)]) {
    if (!candidate) continue;
    try {
      const packed = fs.readFileSync(path.join(candidate, 'packed-refs'), 'utf8');
      for (const line of packed.split(/\r?\n/)) {
        if (line.startsWith('#')) continue;
        const [hash, name] = line.split(' ');
        if (name === ref && hash) return hash.trim();
      }
    } catch {
      // No packed-refs here; try the other location.
    }
  }
  return null;
}

/**
 * A worktree keeps its own HEAD but shares the main repository's refs, and
 * points at it through a `commondir` file.
 */
function commonDir(gitDir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return path.isAbsolute(value) ? value : path.resolve(gitDir, value);
  } catch {
    return null;
  }
}

/**
 * The commit, read from the git checkout when there is one.
 *
 * Deliberately not `git rev-parse`: spawning a process to answer a question
 * about a text file is slower, needs git on PATH, and fails differently on a
 * machine where git is absent — which is every installed copy. The cost is
 * having to know the three places a ref can live, which is what the helpers
 * above are for.
 */
export function readGitCommit(root: string): string | null {
  const gitDir = resolveGitDir(root);
  if (!gitDir) return null;

  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }

  // Detached HEAD: the hash is right there.
  if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/i.test(head) ? head : null;

  const ref = head.slice(4).trim();
  // Loose ref, in the worktree's own dir or the shared one, then packed-refs.
  for (const dir of [gitDir, commonDir(gitDir)]) {
    if (!dir) continue;
    try {
      const hash = fs.readFileSync(path.join(dir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(hash)) return hash;
    } catch {
      // Not here. Try the next location.
    }
  }
  return readPackedRef(gitDir, ref);
}

function readBuildDate(root: string): string | null {
  try {
    return fs.statSync(path.join(root, 'server', 'dist', 'index.js')).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * The commit the RELEASE was built from, stamped by the packager.
 *
 * An installed copy has no .git, so without this the only remaining source is
 * APP_RELEASE_REF — and the shipped .env template sets that to a placeholder
 * (`v0.0.0`). An install therefore reported a commit that never existed while
 * the release's own Version.txt named the real one. Found by installing from
 * the built KasSetup.exe and asking it for its version.
 */
function readBuildStamp(root: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'kas-release.json'), 'utf8')) as {
      commit?: string;
    };
    return parsed.commit && parsed.commit.length > 0 ? parsed.commit : null;
  } catch {
    return null;
  }
}

let cached: VersionInfo | null = null;

export function versionInfo(root: string = REPO_ROOT): VersionInfo {
  if (cached && root === REPO_ROOT) return cached;
  const info: VersionInfo = {
    appVersion: readAppVersion(root),
    // Order of authority: what this checkout IS, then what the build stamped,
    // then what an operator declared. A developer's working tree wins because
    // it is the truth on that machine; the build stamp beats APP_RELEASE_REF
    // because it is a fact about the artifact rather than a value someone may
    // have left at the template's default.
    gitCommit: readGitCommit(root) ?? readBuildStamp(root) ?? process.env.APP_RELEASE_REF ?? null,
    buildDate: readBuildDate(root),
    environment: process.env.NODE_ENV ?? 'development',
    nodeVersion: process.versions.node,
  };
  if (root === REPO_ROOT) cached = info;
  return info;
}

/** Test seam: forget the cached value. */
export function resetVersionCache(): void {
  cached = null;
}

/** One line, for a log or a console banner. */
export function versionLine(info: VersionInfo = versionInfo()): string {
  const commit = info.gitCommit ? info.gitCommit.slice(0, 8) : 'không rõ';
  return `Kas ${info.appVersion} (commit ${commit}, Node ${info.nodeVersion}, ${info.environment})`;
}

/** The multi-line form `--version` prints. */
export function versionReport(info: VersionInfo = versionInfo()): string[] {
  return [
    `Phiên bản ứng dụng : ${info.appVersion}`,
    `Git commit         : ${info.gitCommit ?? '(không có — bản cài đặt không kèm .git)'}`,
    `Thời điểm build    : ${info.buildDate ?? '(chưa build)'}`,
    `Môi trường         : ${info.environment}`,
    `Node.js            : v${info.nodeVersion}`,
  ];
}
