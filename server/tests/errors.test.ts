import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { serveClient } from '../src/config/env';

const app = createApp();

describe('error responses', () => {
  it('returns 404 for an unknown route', async () => {
    const response = await request(app).get('/api/khong-ton-tai');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for an unknown non-API path when no client is mounted', async () => {
    // CONDITIONAL ON PURPOSE. This asserted an unconditional 404 and so
    // silently depended on `serveClient` being false — it broke the moment a
    // developer set SERVE_CLIENT=true to work on the PWA locally.
    //
    // Both outcomes are correct, and which one applies is the whole point:
    //   client mounted  -> the SPA shell, so a deep link like /app/booking/123
    //                      survives a refresh;
    //   no client       -> a JSON 404 from the error handler.
    // What must NEVER happen is an /api path answering with HTML, and the test
    // above pins that separately.
    const response = await request(app).get('/totally-unknown');

    if (serveClient) {
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/html/);
    } else {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('uses one consistent error body shape', async () => {
    const response = await request(app).post('/api/khong-ton-tai');

    expect(response.body).toMatchObject({
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
      requestId: expect.any(String),
    });
    // The error object carries exactly code/message (+ optional details).
    expect(Object.keys(response.body).sort()).toEqual(['error', 'requestId']);
  });

  it('rejects malformed JSON with a 400 in the same shape', async () => {
    const response = await request(app)
      .post('/api/khong-ton-tai')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.requestId).toBeTruthy();
  });
});
