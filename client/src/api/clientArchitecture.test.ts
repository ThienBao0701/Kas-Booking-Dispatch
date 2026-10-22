// @vitest-environment node
/**
 * The client–server rule, asserted against the source rather than trusted.
 *
 * THE PROPERTY THIS FILE PROTECTS: a reception PC never becomes a second
 * server. Kas has exactly one backend, one database and one set of uploads, and
 * every other machine is a browser pointed at it. The failure this prevents is
 * not a crash — it is two branches quietly writing to two different databases
 * and nobody noticing until the day they disagree.
 *
 * Two mechanisms enforce it, and both are checked here:
 *
 *   The API base is RELATIVE. An installed PWA can only ever talk back to the
 *   origin it was installed from, so there is no address to configure wrongly
 *   and no way to aim a branch at the wrong machine.
 *
 *   Nothing in the client can start a backend. There is no database driver, no
 *   server framework and no process spawning in the browser bundle, so "run it
 *   locally" is not a mistake anyone can make by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT_SRC = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(CLIENT_SRC, '..');

/** Every TypeScript source file in the client, excluding tests. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(CLIENT_SRC);
  return found;
}

const FILES = sourceFiles();
const read = (file: string) => fs.readFileSync(file, 'utf8');

/* ================================================================== */
/* The client talks to the origin it came from                         */
/* ================================================================== */
describe('the API address', () => {
  it('is relative, so it is whatever origin served the app', () => {
    const client = read(path.join(CLIENT_SRC, 'api', 'client.ts'));
    expect(client).toContain("const API_BASE = '/api'");
  });

  it('is never a hardcoded host in code', () => {
    // A branch aimed at a stale IP is a branch dispatching into nothing, and
    // the symptom appears days later as "bookings went missing".
    //
    // COMMENTS ARE STRIPPED FIRST. `installability.ts` legitimately DISCUSSES
    // http://192.168.x.x — explaining that a LAN origin is why installation is
    // impossible — and prose about an address is not a connection to it. A
    // check that could not tell those apart would push people to delete the
    // explanation rather than the address.
    for (const file of FILES) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const hosts = code.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/gi) ?? [];
      expect(hosts, `${path.relative(CLIENT_ROOT, file)} -> ${hosts.join(', ')}`).toEqual([]);
    }
  });

  it('probes health on the same relative base', () => {
    // The reachability probe must not be the one place that hardcodes a host.
    expect(read(path.join(CLIENT_SRC, 'api', 'useServerReachable.ts'))).toContain("'/api/health'");
  });
});

/* ================================================================== */
/* The client cannot become a server                                   */
/* ================================================================== */
describe('no backend in the browser', () => {
  it('declares no server, database or process dependency', () => {
    const pkg = JSON.parse(read(path.join(CLIENT_ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const forbidden of ['express', 'pg', '@prisma/client', 'prisma', 'node-cron']) {
      expect(deps, forbidden).not.toContain(forbidden);
    }
  });

  it('imports no Node runtime module anywhere in the client', () => {
    // child_process or fs in a browser bundle is the shape of "start a local
    // backend", and it cannot appear by accident if it cannot appear at all.
    for (const file of FILES) {
      const source = read(file);
      for (const forbidden of ['node:child_process', 'node:fs', 'node:net', 'child_process']) {
        expect(source, `${path.relative(CLIENT_ROOT, file)} imports ${forbidden}`).not.toContain(
          `'${forbidden}'`,
        );
      }
    }
  });

  it('ships no entry point that could launch one', () => {
    // The three .cmd entry points live at the repository root and belong to the
    // SERVER install. Nothing equivalent may sit inside the client bundle.
    const clientFiles = fs.readdirSync(CLIENT_ROOT);
    for (const name of clientFiles) {
      expect(name.toLowerCase().endsWith('.cmd'), name).toBe(false);
      expect(name.toLowerCase().endsWith('.ps1'), name).toBe(false);
    }
  });
});
