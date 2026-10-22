import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Static verification of the deployment artefacts.
 *
 * Docker is NOT installed in this development environment, so
 * `docker build` / `docker compose config` cannot be executed here (that is
 * reported as BLOCKED, never as passed). These tests are the strongest
 * guarantee available without a daemon: the Compose file is really parsed as
 * YAML and its structure asserted, and the Dockerfile is checked for the
 * properties that make the image production-safe.
 *
 * They also guard against a whole class of regression that a one-off manual
 * `docker compose config` would not catch: someone later publishing the
 * database or the app port, dropping the non-root user, or adding a bind mount.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: string[];
  expose?: (string | number)[];
  restart?: string;
  networks?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test?: unknown; interval?: string; retries?: number };
  privileged?: boolean;
  security_opt?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
  depends_on?: Record<string, { condition?: string }>;
}

interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  secrets?: Record<string, { file?: string }>;
}

const compose = yaml.load(read('compose.production.yml')) as ComposeFile;
const dockerfile = read('Dockerfile');
const caddyfile = read('Caddyfile');
const dockerignore = read('.dockerignore');
const envExample = read('.env.production.example');
const gitignore = read('.gitignore');

/* ================================================================== */
/* 29  Image safety                                                    */
/* ================================================================== */

describe('Dockerfile', () => {
  it('29. the container runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    // The USER directive must come before the process is started, otherwise the
    // app would still run as root.
    expect(dockerfile.indexOf('USER node')).toBeLessThan(dockerfile.indexOf('CMD ['));
    // Writable paths are pre-owned by that user.
    expect(dockerfile).toMatch(/chown -R node:node/);
  });

  it('29b. dependencies install reproducibly from the lockfile', () => {
    expect(dockerfile).toMatch(/COPY package\.json package-lock\.json/);
    expect(dockerfile).toMatch(/RUN npm ci\b/);
    // Never a floating `npm install` in an image build.
    expect(dockerfile).not.toMatch(/RUN npm install\b/);
    // Runtime keeps only production dependencies.
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
  });

  it('29c. it is multi-stage and ships only build output', () => {
    const stages = [...dockerfile.matchAll(/^FROM .+ AS (\w+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(expect.arrayContaining(['deps', 'build', 'runtime']));
    expect(dockerfile).toMatch(/COPY --from=build \/app\/server\/dist \.\/server\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/client\/dist \.\/client\/dist/);
  });

  it('29d. production never runs TypeScript, Vite or a watcher', () => {
    expect(dockerfile).toMatch(/CMD \["node", "server\/dist\/index\.js"\]/);

    // Only the executable directives matter — the prose comments legitimately
    // mention the tools that are deliberately absent.
    const directives = dockerfile
      .split('\n')
      .filter((line) => /^\s*(RUN|CMD|ENTRYPOINT)\b/.test(line))
      .join('\n');
    for (const forbidden of ['tsx', 'nodemon', 'vite', 'ts-node']) {
      expect(directives, forbidden).not.toContain(forbidden);
    }
    expect(dockerfile).toMatch(/ENV NODE_ENV=production/);
  });

  it('29e. it declares a health check against the real endpoint', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/\/api\/health/);
  });

  it('29f. no secret is baked into the image', () => {
    // No secret-looking literal, and secrets arrive as mounted files at runtime.
    expect(dockerfile).not.toMatch(/SESSION_SECRET=\S/);
    expect(dockerfile).not.toMatch(/PASSWORD=\S/);
    expect(dockerfile).not.toMatch(/COPY .*\.env/);
    // Git metadata and env files are excluded from the build context entirely.
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^secrets\/$/m);
    expect(dockerignore).toMatch(/^server\/tests$/m);
    expect(dockerignore).toMatch(/^backups\/$/m);
  });

  it('29g. it uses a supported Node LTS matching the project engines', () => {
    const arg = /ARG NODE_VERSION=(\d+)-/.exec(dockerfile);
    expect(arg).not.toBeNull();
    const major = Number(arg![1]);
    // package.json engines: ">=22 <25"
    expect(major).toBeGreaterThanOrEqual(22);
    expect(major).toBeLessThan(25);
  });
});

/* ================================================================== */
/* 30–33  Compose topology                                             */
/* ================================================================== */

describe('compose.production.yml', () => {
  it('30. parses as valid YAML with the expected services', () => {
    expect(compose.services).toBeDefined();
    expect(Object.keys(compose.services).sort()).toEqual(['app', 'caddy']);
    expect(compose.networks).toBeDefined();
    expect(compose.volumes).toBeDefined();
  });

  it('30b. every service restarts automatically and is unprivileged', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.restart, name).toBe('unless-stopped');
      expect(service.privileged, name).toBeUndefined();
      expect(service.security_opt, name).toContain('no-new-privileges:true');
      expect(service.logging?.driver, name).toBe('json-file');
      expect(service.logging?.options?.['max-size'], name).toBeTruthy();
      expect(service.logging?.options?.['max-file'], name).toBeTruthy();
    }
  });

  it('31. only Caddy publishes ports, and only 80 and 443', () => {
    const published = Object.entries(compose.services).flatMap(([name, service]) =>
      (service.ports ?? []).map((p) => ({ name, port: p })),
    );
    // Every published port belongs to caddy…
    expect(published.every((p) => p.name === 'caddy')).toBe(true);
    // …and is exactly 80 or 443 (tcp or udp).
    const hostPorts = published.map((p) => String(p.port).split(':')[0]);
    expect([...new Set(hostPorts)].sort()).toEqual(['443', '80']);
  });

  it('32. no database port is published anywhere', () => {
    // Since Phase D.1 the database is PostgreSQL 17 on the Windows HOST, and
    // Docker remains an optional app-only path that dials out to it. There is
    // deliberately no database service here: two copies of the data would be
    // two things to back up and one of them would silently go stale.
    const dbService = compose.services.db ?? compose.services.database ?? compose.services.postgres;
    if (dbService) {
      expect(dbService.ports ?? []).toEqual([]);
    } else {
      expect(Object.keys(compose.services)).not.toContain('db');
    }
    const raw = read('compose.production.yml');
    expect(raw).not.toMatch(/^\s*-\s*"?5432:/m);
  });

  it('33. the application port is exposed internally but never published', () => {
    const app = compose.services.app!;
    expect(app.ports).toBeUndefined();
    expect(app.expose).toEqual(['3001']);
    // Reachable only through the private network.
    expect(app.networks).toContain('kas-internal');
    expect(compose.services.caddy!.networks).toContain('kas-internal');
    const raw = read('compose.production.yml');
    expect(raw).not.toMatch(/^\s*-\s*"?3001:3001/m);
  });

  it('33b. all persistent state lives on named volumes, with no bind-mounted source', () => {
    const app = compose.services.app!;
    expect(app.volumes).toEqual(
      expect.arrayContaining([
        'kas-uploads:/data/uploads',
        'kas-backups:/data/backups',
      ]),
    );
    // The database volume is GONE on purpose: PostgreSQL owns its own storage
    // on the host. A lingering kas-db volume would be a stale copy of the
    // SQLite pilot's data that nobody is backing up.
    expect(app.volumes?.some((v) => v.startsWith('kas-db:'))).toBe(false);

    // The only bind mount in the stack is Caddy's read-only config.
    const binds = Object.values(compose.services)
      .flatMap((s) => s.volumes ?? [])
      .filter((v) => v.startsWith('.') || v.startsWith('/'));
    expect(binds).toEqual(['./Caddyfile:/etc/caddy/Caddyfile:ro']);

    expect(Object.keys(compose.volumes ?? {}).sort()).toEqual(
      ['caddy-config', 'caddy-data', 'kas-backups', 'kas-uploads'],
    );
  });

  it('33c. the app health check calls the implemented endpoint and gates Caddy', () => {
    const app = compose.services.app!;
    expect(JSON.stringify(app.healthcheck?.test)).toContain('/api/health');
    expect(app.healthcheck?.interval).toBeTruthy();
    expect(compose.services.caddy!.depends_on?.app?.condition).toBe('service_healthy');
  });

  it('33d. production environment is pinned safely and secrets come from files', () => {
    const env = compose.services.app!.environment!;
    expect(env.NODE_ENV).toBe('production');
    expect(env.ENABLE_DEV_TEST_TOOLS).toBe('false');
    expect(env.SESSION_COOKIE_SECURE).toBe('true');
    expect(env.TRUST_PROXY).toBe('1');
    expect(env.SERVE_CLIENT).toBe('true');
    // Every writable path is a volume path, never inside the image.
    expect(env.PROOF_UPLOAD_DIR).toMatch(/^\/data\//);
    expect(env.ISSUE_UPLOAD_DIR).toMatch(/^\/data\//);
    expect(env.BACKUP_DIR).toMatch(/^\/data\//);

    // Since D.1 the connection URL carries a PASSWORD, so it must arrive as a
    // secret file — never as a literal value in a committed compose file, and
    // never as a plain environment variable visible to `docker inspect`.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DATABASE_URL_FILE).toBe('/run/secrets/database_url');
    const rawCompose = read('compose.production.yml');
    expect(rawCompose).not.toMatch(/DATABASE_URL:\s*["']?postgres/i);
    expect(rawCompose).not.toMatch(/postgres(ql)?:\/\/[^\s"']*:[^\s"']*@/i);
    // The SQLite pilot URL must not survive anywhere in the production stack.
    expect(rawCompose).not.toMatch(/file:\/data\/db/);

    // Secrets are file-backed; no literal secret value appears in the file.
    expect(env.SESSION_SECRET_FILE).toBe('/run/secrets/session_secret');
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.INITIAL_ADMIN_PASSWORD).toBeUndefined();
    expect(Object.keys(compose.secrets ?? {}).sort()).toEqual(
      ['database_url', 'initial_admin_password', 'session_secret'],
    );
  });

  it('33e. no development hot reload or source mount leaks into production', () => {
    const raw = read('compose.production.yml');
    for (const forbidden of ['- ./server:', '- ./client:', '- .:/app', 'vite', 'nodemon', 'npm run dev']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });
});

/* ================================================================== */
/* HTTPS, environment template and repository hygiene                  */
/* ================================================================== */

describe('Caddy and HTTPS', () => {
  it('takes the domain from the environment and hardcodes no real host', () => {
    expect(caddyfile).toContain('{$APP_DOMAIN}');
    // No literal domain or IP address may be committed.
    expect(caddyfile).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(caddyfile).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(com|net|org|vn)\b/i);
  });

  it('reverse-proxies to the real internal port with sane limits and headers', () => {
    expect(caddyfile).toMatch(/reverse_proxy app:3001/);
    const appPort = compose.services.app!.expose![0];
    expect(caddyfile).toContain(`app:${appPort}`);

    // Uploads must fit through the proxy: comfortably above MAX_UPLOAD_MB (10).
    const limit = /max_size\s+(\d+)MB/.exec(caddyfile);
    expect(limit).not.toBeNull();
    expect(Number(limit![1])).toBeGreaterThan(10);

    for (const header of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
    ]) {
      expect(caddyfile, header).toContain(header);
    }
  });
});

describe('environment template and repository hygiene', () => {
  it('the example contains names and explanations, never real values', () => {
    // Reserved, never-resolving TLD only.
    expect(envExample).toMatch(/example\.invalid/);
    expect(envExample).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    // No secret is assigned a value.
    for (const key of ['SESSION_SECRET', 'INITIAL_ADMIN_PASSWORD', 'DATABASE_URL']) {
      expect(envExample, key).not.toMatch(new RegExp(`^${key}=.+`, 'm'));
    }
    expect(envExample).toMatch(/^ENABLE_DEV_TEST_TOOLS=false$/m);
    expect(envExample).toMatch(/^APP_DOMAIN=/m);
    expect(envExample).toMatch(/^APP_ORIGIN=https:\/\//m);
  });

  it('git ignores every real secret, env, database, upload and backup', () => {
    for (const pattern of ['.env.*', 'secrets/', 'backups/', 'server/uploads/', '*.db', 'data/', 'node_modules/']) {
      expect(gitignore, pattern).toContain(pattern);
    }
    // …but the committed templates stay tracked.
    expect(gitignore).toContain('!.env.example');
    expect(gitignore).toContain('!.env.production.example');
  });

  it('the operator scripts exist and are documented', () => {
    for (const script of ['deploy', 'update', 'rollback', 'backup', 'restore', 'health-check']) {
      const file = path.join(REPO_ROOT, 'scripts', 'production', `${script}.sh`);
      expect(fs.existsSync(file), script).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      expect(content.startsWith('#!/usr/bin/env bash'), script).toBe(true);
      // Fail fast on any error rather than continuing a half-done deployment.
      expect(content, script).toMatch(/set -Eeuo pipefail/);
    }

    // Rollback must not silently touch the database.
    const rollback = read('scripts/production/rollback.sh');
    expect(rollback).toMatch(/DOES NOT TOUCH THE DATABASE/);
    expect(rollback).not.toMatch(/prisma migrate (reset|dev)/);

    // Deployment uses only the safe migration command.
    const deploy = read('scripts/production/deploy.sh');
    expect(deploy).toMatch(/prisma migrate deploy/);
    for (const forbidden of ['migrate dev', 'migrate reset', 'db push']) {
      expect(deploy, forbidden).not.toContain(forbidden);
      expect(read('scripts/production/update.sh'), forbidden).not.toContain(forbidden);
    }
  });
});
