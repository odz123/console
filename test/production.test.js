// test/production.test.js — Tests for production hardening features (HTTP)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';

describe('Production Features', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('GET /health returns status ok with expected fields', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(typeof data.uptime_s, 'number');
    assert.ok(data.uptime_s >= 0);
    assert.strictEqual(typeof data.pid, 'number');
    assert.strictEqual(typeof data.memory.rss_mb, 'number');
    assert.strictEqual(typeof data.memory.heap_used_mb, 'number');
    assert.strictEqual(typeof data.memory.heap_total_mb, 'number');
    assert.strictEqual(typeof data.sessions.total, 'number');
    assert.strictEqual(typeof data.sessions.alive, 'number');
    assert.strictEqual(typeof data.websocket_clients, 'number');
  });

  it('responses include security headers', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('x-xss-protection'), '0');
    assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(res.headers.get('permissions-policy'));
    assert.ok(res.headers.get('content-security-policy'));
  });

  it('CSP includes required directives', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("script-src"));
    assert.ok(csp.includes("connect-src"));
  });

  it('security headers present on API routes', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  });

  it('responses include X-Request-ID header (UUID format)', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const requestId = res.headers.get('x-request-id');
    assert.ok(requestId, 'X-Request-ID header should be present');
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('each request gets a unique request ID', async () => {
    const res1 = await fetch(`${baseUrl}/api/projects`);
    const res2 = await fetch(`${baseUrl}/api/projects`);
    assert.notStrictEqual(
      res1.headers.get('x-request-id'),
      res2.headers.get('x-request-id'),
      'request IDs should be unique'
    );
  });

  it('does not rate limit GET requests', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/projects`);
      assert.strictEqual(res.status, 200);
    }
  });

  it('allows normal POST request volume', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rate-limit-test', cwd: process.cwd() }),
    });
    assert.ok(res.status < 429, `expected non-429 status, got ${res.status}`);
  });

  it('returns proper error for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    assert.ok(res.status >= 400);
  });

  it('normal requests complete without timeout', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
  });

  it('rejects session creation for non-existent project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    assert.strictEqual(res.status, 404);
  });
});
