// @vitest-environment node
/**
 * Guards the Vite configuration against two classes of regression.
 *
 * ENCODING. The config was once re-saved by an editor that prepended a UTF-8
 * BOM and re-encoded every Vietnamese string as Latin-1, turning the PWA
 * manifest description into "Trung tÃ¢m Ä‘iá»u phá»‘i…". That text ships to every
 * installed client, so a silent mojibake regression is a user-visible defect.
 *
 * SAFETY. The service worker must never answer an authenticated API request
 * from cache, and the dev server must keep proxying /api to the backend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

const CONFIG_PATH = path.resolve(__dirname, '..', 'vite.config.ts');
const RAW_BYTES = fs.readFileSync(CONFIG_PATH);
const RAW_TEXT = RAW_BYTES.toString('utf8');

/** `defineConfig` here returns a plain object, so it is read directly. */
const cfg = config as unknown as {
  server?: { allowedHosts?: string[]; proxy?: Record<string, { target?: string }> };
  plugins?: unknown[];
};

describe('vite.config.ts — file encoding', () => {
  it('has no UTF-8 BOM', () => {
    const hasBom = RAW_BYTES[0] === 0xef && RAW_BYTES[1] === 0xbb && RAW_BYTES[2] === 0xbf;
    expect(hasBom).toBe(false);
  });

  it('contains no double-encoded (mojibake) sequences', () => {
    // The signatures UTF-8-read-as-Latin-1 leaves behind.
    for (const marker of ['Ã¢', 'â€', 'Ä‘', 'á»', 'áº', 'Ã´', 'Ã¬']) {
      expect(RAW_TEXT.includes(marker), `mojibake marker ${marker}`).toBe(false);
    }
  });

  it('keeps the Vietnamese manifest description as correct Unicode', () => {
    expect(RAW_TEXT).toContain('Trung tâm điều phối đặt phòng Booking.com nội bộ.');
    // Spot-check the characters that mojibake destroys first.
    expect(RAW_TEXT).toContain('â'); // tâm
    expect(RAW_TEXT).toContain('đ'); // điều
    expect(RAW_TEXT).toContain('ộ'); // nội bộ
  });

  it('keeps the em dash in the /api caching comment intact', () => {
    expect(RAW_TEXT).toContain('NEVER for /api — so an');
  });

  it('uses LF line endings', () => {
    expect(RAW_TEXT.includes('\r\n')).toBe(false);
  });
});

describe('vite.config.ts — dev server', () => {
  it('does NOT allow the production hostname', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that is why it is worth
    // reading. It pinned `allowedHosts: ['kasbookingapp.com']` so the dev
    // server would answer the operator's tunnel — and the hotel then ran an
    // entire deployment on that dev server. It worked: Vite proxies /api to
    // the real backend, so logins, dispatch and bookings were all fine. The
    // only casualty was that /manifest.webmanifest and /sw.js came back as
    // HTML, so the app could never be installed and nothing said why.
    //
    // With the hostname absent, Vite refuses the tunnel outright — "Blocked
    // request. This host is not allowed" — which turns a silent wrong-mode
    // deployment into an immediate, obvious failure. Production is served by
    // the backend on one origin, which is what KasService.cmd starts.
    expect(cfg.server?.allowedHosts ?? []).not.toContain('kasbookingapp.com');
  });

  it('names no production hostname at all', () => {
    // Any entry here is a hostname the DEVELOPMENT server will answer to.
    expect(RAW_TEXT).not.toContain('allowedHosts');
  });

  it('still binds to all interfaces for LAN access', () => {
    expect(RAW_TEXT).toContain('host: true');
  });

  it('proxies /api to the backend', () => {
    const proxy = cfg.server?.proxy ?? {};
    expect(Object.keys(proxy)).toContain('/api');
    expect(proxy['/api']?.target).toBeTruthy();
  });
});

describe('vite.config.ts — service worker never caches the API', () => {
  it('excludes /api from the SPA navigation fallback', () => {
    // An authenticated API request answered from the app shell would be a
    // security and correctness bug, not just a caching one.
    expect(RAW_TEXT).toContain('navigateFallbackDenylist');
    expect(RAW_TEXT).toMatch(/navigateFallbackDenylist:\s*\[\/\^\\\/api\/\]/);
  });

  it('precaches only built static assets, never API responses', () => {
    expect(RAW_TEXT).toMatch(/globPatterns:\s*\['\*\*\/\*\.\{js,css,html,svg,png,ico,woff2\}'\]/);
  });

  it('declares runtime caching as explicitly EMPTY, not merely absent', () => {
    // An empty array states the intent — operational data is always fetched
    // live — and makes an accidental future entry a visible diff rather than a
    // silently-added key.
    expect(RAW_TEXT).toMatch(/runtimeCaching:\s*\[\]/);
    // Nothing that would cache an API route.
    expect(RAW_TEXT).not.toMatch(/urlPattern[^\n]*api/i);
    expect(RAW_TEXT).not.toContain('NetworkFirst');
    expect(RAW_TEXT).not.toContain('StaleWhileRevalidate');
  });

  it('still registers the PWA plugin so the production build stays installable', () => {
    expect(RAW_TEXT).toContain('VitePWA(');
    expect(RAW_TEXT).toContain("registerType: 'prompt'");
    expect((cfg.plugins ?? []).length).toBeGreaterThan(0);
  });
});
