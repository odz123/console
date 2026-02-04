// test/server.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';

describe('Projects API', () => {
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

  it('GET /api/projects returns empty projects and sessions initially', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
    assert.ok(Array.isArray(data.sessions));
    assert.strictEqual(data.projects.length, 0);
    assert.strictEqual(data.sessions.length, 0);
  });

  it('POST /api/projects creates a project', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-proj', cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 201);
    const proj = await res.json();
    assert.ok(proj.id);
    assert.strictEqual(proj.name, 'test-proj');
    assert.ok(proj.cwd);
    assert.ok(proj.createdAt);
  });

  it('POST /api/projects rejects invalid cwd', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', cwd: '/nonexistent/xyz' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/projects rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/projects/:id removes project', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', cwd: process.cwd() }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { projects } = await listRes.json();
    assert.ok(!projects.find((p) => p.id === id));
  });

  it('DELETE /api/projects/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
  });
});

describe('Sessions API (scoped to projects)', () => {
  let server;
  let baseUrl;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a project to use
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'session-test-proj', cwd: process.cwd() }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
  });

  it('POST /api/projects/:id/sessions creates a session', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-session' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    assert.ok(session.id);
    assert.strictEqual(session.projectId, projectId);
    assert.strictEqual(session.name, 'test-session');
    assert.strictEqual(session.status, 'running');
    assert.strictEqual(session.alive, true);
  });

  it('POST /api/projects/:id/sessions returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'orphan' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/projects/:id/sessions rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/sessions/:id removes session', async () => {
    // Create a session first
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
  });

  it('POST /api/sessions/:id/restart restarts session', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-restart' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}/restart`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const session = await res.json();
    assert.strictEqual(session.alive, true);
  });

  it('DELETE /api/projects/:id also removes its sessions', async () => {
    // Create a fresh project with a session
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cascade-test', cwd: process.cwd() }),
    });
    const proj = await projRes.json();

    await fetch(`${baseUrl}/api/projects/${proj.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'child-session' }),
    });

    // Delete project
    const delRes = await fetch(`${baseUrl}/api/projects/${proj.id}`, { method: 'DELETE' });
    assert.strictEqual(delRes.status, 200);

    // Verify project and its sessions are gone from GET /api/projects
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { projects, sessions } = await listRes.json();
    assert.ok(!projects.find((p) => p.id === proj.id));
    assert.ok(!sessions.find((s) => s.projectId === proj.id), 'cascade: sessions should be removed');
  });
});
