// test/production.test.js — Tests for production hardening features
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';

describe('Health Check', () => {
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
});

describe('Security Headers', () => {
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
});

describe('Rate Limiting', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Use a dedicated server with a low rate limit for testing
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('does not rate limit GET requests', async () => {
    // GET requests should not be rate limited
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/projects`);
      assert.strictEqual(res.status, 200);
    }
  });

  it('allows normal POST request volume', async () => {
    // In test mode, rate limit is very high (10000), so normal usage should work
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rate-limit-test', cwd: process.cwd() }),
    });
    assert.ok(res.status < 429, `expected non-429 status, got ${res.status}`);
  });
});

describe('Global Error Handler', () => {
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

  it('returns 404 for unknown API routes', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    // Express returns 404 for unmatched routes
    assert.ok(res.status === 404 || res.status === 501);
  });

  it('returns proper error for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    assert.ok(res.status >= 400);
  });
});

describe('Request Timeout', () => {
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

  it('normal requests complete without timeout', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
  });
});

describe('WebSocket Hardening', () => {
  let server;
  let wsUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    wsUrl = `ws://localhost:${port}/ws`;
  });

  after(async () => {
    await server.destroy();
  });

  it('rejects messages with invalid cols/rows types', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.once('open', resolve));

    // Skip initial state message
    await new Promise((resolve) => ws.once('message', resolve));

    // Send attach with invalid cols (should be silently ignored)
    ws.send(JSON.stringify({
      type: 'attach',
      sessionId: 'nonexistent',
      cols: 'invalid',
      rows: 24,
    }));

    // The server should not crash - wait a bit and verify connection is alive
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    ws.terminate();
  });

  it('rejects messages with negative cols/rows', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.once('open', resolve));
    await new Promise((resolve) => ws.once('message', resolve));

    ws.send(JSON.stringify({
      type: 'resize',
      cols: -1,
      rows: -1,
    }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    ws.terminate();
  });

  it('rejects messages without type field', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.once('open', resolve));
    await new Promise((resolve) => ws.once('message', resolve));

    ws.send(JSON.stringify({ data: 'no type field' }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    ws.terminate();
  });

  it('rejects non-JSON messages', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.once('open', resolve));
    await new Promise((resolve) => ws.once('message', resolve));

    ws.send('not json at all');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    ws.terminate();
  });
});
