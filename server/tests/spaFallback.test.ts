/**
 * THE SHELL ANSWERS PAGES, NEVER FILES.
 *
 * Found on the live site: after a release, the previous build's script
 * (`/assets/index-<old>.js`) was answered with index.html — 200 text/html —
 * which a browser holding the older page or app refuses to run (nosniff): a
 * blank screen. A missing file must be a 404; every page still gets the shell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { servesSpaShell } from '../src/middleware/spaFallback';

describe('which requests the single-page shell answers', () => {
  it('answers page navigations, deep links included', () => {
    for (const p of ['/', '/login', '/app', '/app/hk/rooms', '/app/inspections/room/cmv8ficos0129w3icjsndelk4', '/app/booking/42']) {
      expect(servesSpaShell('GET', p), p).toBe(true);
    }
    expect(servesSpaShell('HEAD', '/app')).toBe(true);
  });

  it('never answers a file, the API, or anything but GET / HEAD', () => {
    for (const p of ['/assets/index-DPjHEXQq.js', '/assets/index-x.css', '/assets', '/sw.js', '/registerSW.js', '/manifest.webmanifest', '/icon-192.png', '/x.map', '/api', '/api/nope']) {
      expect(servesSpaShell('GET', p), p).toBe(false);
    }
    expect(servesSpaShell('POST', '/login')).toBe(false);
  });
});

describe('in front of a built client', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-spa-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Kas</title><script src="/assets/index-NEW.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-NEW.js'), 'console.log(1)');
  // The same order as app.ts mountClient: static files, then the shell for pages, then 404.
  const app = express();
  app.use(express.static(dist, { index: false }));
  app.use((req, res, next) => {
    if (!servesSpaShell(req.method, req.path)) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  it('serves the current build’s script, and 404s the previous build’s instead of sending HTML', async () => {
    const current = await request(app).get('/assets/index-NEW.js');
    expect(current.status).toBe(200);
    expect(current.headers['content-type']).toMatch(/javascript/);
    const old = await request(app).get('/assets/index-DPjHEXQq.js');
    expect(old.status).toBe(404);
    expect(old.headers['content-type']).not.toMatch(/html/);
  });

  it('still gives every page its shell', async () => {
    for (const p of ['/', '/login', '/app/hk/rooms']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('<title>Kas</title>');
    }
  });
});
