/**
 * WHAT THE SINGLE-PAGE SHELL (index.html) MAY ANSWER: page navigations only.
 *
 * A browser holding an older page — or an older installed app's service worker
 * — asks for the JavaScript and CSS of THAT build (`/assets/index-<old>.js`).
 * After a release those files are gone. If the shell answered them, the browser
 * would receive HTML for a script; with `X-Content-Type-Options: nosniff` it
 * refuses to run it, and the user sees a blank screen with nothing to explain
 * it. A missing file must be a plain 404, which the app's own update handling
 * (and a reload) can recover from.
 *
 * So the shell never answers:
 *   - anything but GET / HEAD;
 *   - `/api` and below (an unknown API route stays a JSON 404);
 *   - `/assets/…`, the hashed build output;
 *   - any path ending in a file extension (`/sw.js`, `/icon.png`, `/x.map`).
 *
 * Every application route (`/login`, `/app/inspections/room/<id>`, …) has no
 * extension, so every page still loads by its address.
 */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,16}$/;

export function servesSpaShell(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (path === '/assets' || path.startsWith('/assets/')) return false;
  return !FILE_EXTENSION.test(path);
}
