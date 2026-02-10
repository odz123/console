// test/production-ws.test.js — WebSocket hardening tests
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createServer } from '../server.js';

describe('WebSocket Hardening', () => {
  let server;
  let wsUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    wsUrl = `ws://localhost:${server.address().port}/ws`;
  });

  after(async () => {
    await server.destroy();
  });

  // Helper: connect and wait for the initial state message.
  // Sets up the message listener BEFORE open to avoid a race condition
  // where the server's immediate state message is missed between
  // the open event resolving and the next .once('message') registration.
  async function connectAndSkipState() {
    const ws = new WebSocket(wsUrl);
    const stateMsg = new Promise((resolve) => ws.once('message', resolve));
    await new Promise((resolve) => ws.once('open', resolve));
    await stateMsg;
    return ws;
  }

  it('rejects messages with invalid cols/rows types', async () => {
    const ws = await connectAndSkipState();

    ws.send(JSON.stringify({
      type: 'attach',
      sessionId: 'nonexistent',
      cols: 'invalid',
      rows: 24,
    }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    ws.terminate();
  });

  it('rejects messages with negative cols/rows', async () => {
    const ws = await connectAndSkipState();

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
    const ws = await connectAndSkipState();

    ws.send(JSON.stringify({ data: 'no type field' }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    ws.terminate();
  });

  it('rejects non-JSON messages', async () => {
    const ws = await connectAndSkipState();

    ws.send('not json at all');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    ws.terminate();
  });

  it('sends pong in response to ping (heartbeat support)', async () => {
    const ws = await connectAndSkipState();

    const pongReceived = new Promise((resolve) => {
      ws.on('pong', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    ws.ping();
    const gotPong = await pongReceived;
    assert.ok(gotPong, 'should receive pong response');
    ws.terminate();
  });
});
