/**
 * ONE ADDRESS FOR THE APPLICATION — a page opened by the LAN address is sent to
 * the public origin; nothing that came through the tunnel, nothing on loopback
 * and no API call is ever redirected.
 *
 * The incident: production is configured for https://kasbookingapp.com (Secure
 * cookie, same-origin check, upgrade-insecure-requests). Computers set up with
 * the old guide's `http://<server-ip>:3001` got a blank page (scripts upgraded
 * to an https port that does not exist) and a refused login.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { canonicalOriginRedirect, canonicalRedirectTarget, type CanonicalRequest } from '../src/middleware/canonicalOrigin';

const PROD = { production: true, appOrigin: 'https://kasbookingapp.com' };

const page = (host: string | undefined, url = '/login', extra: Record<string, string> = {}, method = 'GET'): CanonicalRequest => ({
  method,
  path: url.split('?')[0]!,
  originalUrl: url,
  headers: { ...(host === undefined ? {} : { host }), ...extra },
});

describe('which requests are sent to the public origin', () => {
  it('sends a page opened by the LAN address to the same path on the public origin', () => {
    expect(canonicalRedirectTarget(page('192.168.1.203:3001'), PROD)).toBe('https://kasbookingapp.com/login');
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '/app/inspections?tab=2'), PROD)).toBe(
      'https://kasbookingapp.com/app/inspections?tab=2',
    );
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '/'), PROD)).toBe('https://kasbookingapp.com/');
    expect(canonicalRedirectTarget(page('kas-server:3001', '/', {}, 'HEAD'), PROD)).toBe('https://kasbookingapp.com/');
  });

  it('never redirects what came through the Cloudflare tunnel, whatever its Host header', () => {
    for (const host of ['kasbookingapp.com', '192.168.1.203:3001', 'localhost:3001', 'origin.internal']) {
      expect(canonicalRedirectTarget(page(host, '/login', { 'cf-ray': '8d2f0a1b2c3d4e5f-SIN' }), PROD), host).toBeNull();
      expect(canonicalRedirectTarget(page(host, '/login', { 'cf-connecting-ip': '203.0.113.7' }), PROD), host).toBeNull();
    }
  });

  it('never redirects the public host itself or loopback', () => {
    expect(canonicalRedirectTarget(page('kasbookingapp.com'), PROD)).toBeNull();
    expect(canonicalRedirectTarget(page('KASBOOKINGAPP.COM'), PROD)).toBeNull();
    for (const host of ['localhost:3001', '127.0.0.1:3001', '127.0.0.1', '[::1]:3001', 'LOCALHOST']) {
      expect(canonicalRedirectTarget(page(host), PROD), host).toBeNull();
    }
  });

  it('never touches the API, other methods, development, or a server without APP_ORIGIN', () => {
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '/api/health'), PROD)).toBeNull();
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '/api'), PROD)).toBeNull();
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '/login', {}, 'POST'), PROD)).toBeNull();
    expect(canonicalRedirectTarget(page('192.168.1.203:3001'), { production: false, appOrigin: PROD.appOrigin })).toBeNull();
    expect(canonicalRedirectTarget(page('192.168.1.203:3001'), { production: true, appOrigin: undefined })).toBeNull();
    expect(canonicalRedirectTarget(page(undefined), PROD)).toBeNull();
  });

  it('can only ever point at the configured origin — no open redirect', () => {
    expect(canonicalRedirectTarget(page('192.168.1.203:3001', '//evil.example/x'), PROD)).toBeNull();
    expect(canonicalRedirectTarget(page('evil.example', '/login'), PROD)).toBe('https://kasbookingapp.com/login');
    expect(canonicalRedirectTarget(page('bad host header'), PROD)).toBeNull();
  });
});

describe('as middleware in front of the client', () => {
  const app = express();
  app.use(canonicalOriginRedirect(PROD));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use((_req, res) => res.type('html').send('<!doctype html><title>Kas</title>'));

  it('answers the LAN address with a temporary, uncached redirect', async () => {
    const res = await request(app).get('/login').set('Host', '192.168.1.203:3001');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://kasbookingapp.com/login');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves the page through the tunnel and on loopback, and the API everywhere', async () => {
    const viaTunnel = await request(app).get('/login').set('Host', 'kasbookingapp.com').set('cf-ray', '8d2f0a1b2c3d4e5f-SIN');
    expect(viaTunnel.status).toBe(200);
    expect((await request(app).get('/login').set('Host', 'localhost:3001')).status).toBe(200);
    const lanApi = await request(app).get('/api/health').set('Host', '192.168.1.203:3001');
    expect(lanApi.status).toBe(200);
    expect(lanApi.body).toEqual({ status: 'ok' });
  });
});
