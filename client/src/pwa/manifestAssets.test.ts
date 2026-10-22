// @vitest-environment node
/**
 * The shipped manifest and the icon files behind it.
 *
 * Every icon is verified by reading its PNG header, not by trusting the
 * filename. A manifest entry claiming "512x512" while the file is a 48px
 * placeholder passes any check that only looks at names, and Chrome silently
 * refuses to install — which is the failure mode this whole phase is about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');

/** The manifest as vite-plugin-pwa was configured with it. */
const manifest = (() => {
  const plugins = (config as unknown as { plugins?: unknown[] }).plugins ?? [];
  // The PWA plugin is registered as an array of sub-plugins; the options object
  // is read from the config source instead, which is what actually ships.
  const raw = fs.readFileSync(path.resolve(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
  expect(plugins.length).toBeGreaterThan(0);
  return raw;
})();

/** Width and height straight from the PNG IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buffer = fs.readFileSync(file);
  const isPng = buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG';
  expect(isPng, `${path.basename(file)} is a PNG`).toBe(true);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const ANY_SIZES = [16, 32, 48, 64, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];
const MASKABLE_SIZES = [192, 384, 512];

/* ================================================================== */
/* Icons exist, and are the size they claim                            */
/* ================================================================== */
describe('icon files', () => {
  it.each(ANY_SIZES)('ships a real %ipx icon', (size) => {
    const file = path.join(ICON_DIR, `icon-${size}.png`);
    expect(fs.existsSync(file), file).toBe(true);
    expect(pngSize(file)).toEqual({ width: size, height: size });
  });

  it.each(MASKABLE_SIZES)('ships a real %ipx maskable icon', (size) => {
    const file = path.join(ICON_DIR, `icon-maskable-${size}.png`);
    expect(fs.existsSync(file), file).toBe(true);
    expect(pngSize(file)).toEqual({ width: size, height: size });
  });

  it('ships the Apple touch icon at 180px', () => {
    expect(pngSize(path.join(ICON_DIR, 'apple-touch-icon-180.png'))).toEqual({
      width: 180,
      height: 180,
    });
  });

  it.each([70, 150, 310])('ships a real %ipx Windows tile', (size) => {
    expect(pngSize(path.join(ICON_DIR, `mstile-${size}.png`))).toEqual({
      width: size,
      height: size,
    });
  });

  it('ships a multi-size favicon.ico', () => {
    const ico = fs.readFileSync(path.join(PUBLIC_DIR, 'favicon.ico'));
    // ICONDIR: reserved 0, type 1 (icon), then the image count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(3);
  });

  it('contains no zero-byte or truncated icon', () => {
    for (const name of fs.readdirSync(ICON_DIR)) {
      const buffer = fs.readFileSync(path.join(ICON_DIR, name));
      expect(buffer.length, name).toBeGreaterThan(200);
      // A complete PNG ends with the IEND chunk.
      expect(buffer.toString('ascii', buffer.length - 8, buffer.length - 4), name).toBe('IEND');
    }
  });
});

/* ================================================================== */
/* The manifest Chrome and Edge read                                   */
/* ================================================================== */
describe('manifest', () => {
  it('declares the fields required for installability', () => {
    // Chrome requires name (or short_name), start_url, a display mode outside
    // "browser", and icons at 192 and 512. Anything missing means no install.
    for (const field of ['name:', 'short_name:', 'start_url:', 'scope:', 'display:']) {
      expect(manifest).toContain(field);
    }
    expect(manifest).toContain("display: 'standalone'");
  });

  it('declares both 192 and 512 in the "any" purpose', () => {
    expect(manifest).toContain("src: 'icons/icon-192.png', sizes: '192x192'");
    expect(manifest).toContain("src: 'icons/icon-512.png', sizes: '512x512'");
  });

  it('keeps maskable a separate purpose from any', () => {
    // "any maskable" on one entry makes desktop icons look shrunken, because
    // the platform applies the maskable safe-zone padding to both uses.
    expect(manifest).toContain("icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'");
    expect(manifest).not.toContain("purpose: 'any maskable'");
  });

  it('sets a stable id so a start_url change cannot fork the installed app', () => {
    expect(manifest).toContain("id: '/'");
  });

  it('prefers a chrome-less desktop window but degrades to standalone', () => {
    expect(manifest).toContain('display_override');
    expect(manifest).toContain('window-controls-overlay');
    // The fallback must remain in the list, or an unsupporting browser gets
    // nothing to fall back to.
    expect(manifest).toMatch(/display_override:[^\]]*'standalone'/);
  });

  it('declares taskbar shortcuts that point at routes which exist', () => {
    for (const route of ['/app/new', '/app/dispatch', '/app/dashboard']) {
      expect(manifest).toContain(`url: '${route}'`);
    }
  });

  it('keeps theme and background colours consistent with the shell', () => {
    expect(manifest).toContain("theme_color: '#2563eb'");
    expect(manifest).toContain("background_color: '#ffffff'");
  });
});

/* ================================================================== */
/* Head tags and static PWA assets                                     */
/* ================================================================== */
describe('index.html and static assets', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8');

  it('declares the theme colour the installed title bar uses', () => {
    expect(html).toContain('name="theme-color" content="#2563eb"');
  });

  it('opts into safe-area insets', () => {
    // Without viewport-fit=cover every env(safe-area-inset-*) resolves to 0.
    expect(html).toContain('viewport-fit=cover');
  });

  it('links the favicon and the Apple touch icon', () => {
    expect(html).toContain('/favicon.ico');
    expect(html).toContain('apple-touch-icon-180.png');
  });

  it('points Windows at the tile configuration', () => {
    expect(html).toContain('msapplication-config');
    expect(fs.existsSync(path.join(PUBLIC_DIR, 'browserconfig.xml'))).toBe(true);
  });

  it('ships a self-contained offline page', () => {
    const offline = fs.readFileSync(path.join(PUBLIC_DIR, 'offline.html'), 'utf8');
    // It is displayed when the network is gone, so it must not depend on one.
    expect(offline).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(offline).not.toMatch(/<script[^>]+src=/);
    expect(offline).toContain('Thử lại');
    expect(offline).toContain("addEventListener('online'");
  });
});
