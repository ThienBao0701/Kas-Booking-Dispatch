/**
 * Copies non-TypeScript assets from src/ into dist/ after `tsc`.
 *
 * WHY THIS EXISTS
 *
 * `tsc` compiles .ts and copies nothing else, and BOTH deployment paths ship
 * only the compiled output — the Dockerfile does `COPY --from=build
 * /app/server/dist ./server/dist`, and Package-Kas.ps1 does
 * `Copy-Payload 'server\dist'`. A font sitting in src/ therefore exists in
 * development, passes every test, and is missing the moment it is deployed.
 *
 * Kept deliberately small and dependency-free: a list of globs would be another
 * thing to install and another thing to get wrong.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');

/** Directories under src/ copied verbatim into dist/. */
const ASSET_DIRS = ['report/fonts'];

for (const rel of ASSET_DIRS) {
  const from = join(serverRoot, 'src', rel);
  const to = join(serverRoot, 'dist', rel);
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  const files = await readdir(to);
  console.log(`copied ${files.length} file(s): src/${rel} -> dist/${rel}`);
}
