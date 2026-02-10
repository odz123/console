// test/git-api.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.js';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-api-test-'));
  execSync('git init && git -c commit.gpgsign=false commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('Git API - Status', () => {
  let server, baseUrl, tempDir, sessionId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-status-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'status-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('GET /api/sessions/:id/git/status returns branch and empty changes for clean repo', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.branch, 'should have branch');
    assert.ok(Array.isArray(data.staged), 'should have staged array');
    assert.ok(Array.isArray(data.unstaged), 'should have unstaged array');
    assert.ok(Array.isArray(data.untracked), 'should have untracked array');
    assert.strictEqual(typeof data.ahead, 'number');
    assert.strictEqual(typeof data.behind, 'number');
  });

  it('GET /api/sessions/:id/git/status shows untracked files', async () => {
    // Get the worktree path from session
    const projRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await projRes.json();
    const session = sessions.find(s => s.id === sessionId);
    const worktreePath = path.join(tempDir, session.worktreePath);

    // Create a new file
    fs.writeFileSync(path.join(worktreePath, 'new-file.txt'), 'hello');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.untracked.includes('new-file.txt'), 'should show new-file.txt as untracked');
  });

  it('GET /api/sessions/:id/git/status returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/status`);
    assert.strictEqual(res.status, 404);
  });
});

describe('Git API - Stage/Unstage', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-stage-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'stage-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/sessions/:id/git/stage stages a file', async () => {
    fs.writeFileSync(path.join(worktreePath, 'stage-me.txt'), 'content');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['stage-me.txt'] }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    // Verify it's staged
    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const status = await statusRes.json();
    assert.ok(status.staged.some(f => f.path === 'stage-me.txt'), 'file should be staged');
  });

  it('POST /api/sessions/:id/git/stage stages all with all=true', async () => {
    fs.writeFileSync(path.join(worktreePath, 'stage-all-1.txt'), 'a');
    fs.writeFileSync(path.join(worktreePath, 'stage-all-2.txt'), 'b');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    assert.strictEqual(res.status, 200);

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const status = await statusRes.json();
    assert.ok(status.staged.length >= 2, 'multiple files should be staged');
    assert.strictEqual(status.untracked.length, 0, 'no files should be untracked');
  });

  it('POST /api/sessions/:id/git/unstage unstages files', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    assert.strictEqual(res.status, 200);

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const status = await statusRes.json();
    assert.strictEqual(status.staged.length, 0, 'no files should be staged after unstage all');
  });

  it('POST /api/sessions/:id/git/stage rejects path traversal', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['../../etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });

  it('POST /api/sessions/:id/git/stage rejects empty paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('Git API - Commit', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-commit-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'commit-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/sessions/:id/git/commit creates a commit', async () => {
    // Stage a file first
    fs.writeFileSync(path.join(worktreePath, 'committed.txt'), 'committed content');
    await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['committed.txt'] }),
    });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test commit message' }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.commit.hash, 'should return commit hash');
    assert.ok(data.commit.shortHash, 'should return short hash');
    assert.strictEqual(data.commit.message, 'Test commit message');
  });

  it('POST /api/sessions/:id/git/commit rejects empty message', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/sessions/:id/git/commit rejects when nothing staged', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'No staged files' }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Nothing staged'));
  });
});

describe('Git API - Diff', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create an initial file and commit it
    fs.writeFileSync(path.join(tempDir, 'existing.txt'), 'original content');
    execSync('git add existing.txt && git -c commit.gpgsign=false commit -m "add file"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-diff-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'diff-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('GET /api/sessions/:id/git/diff returns diff for modified file', async () => {
    // Modify a tracked file
    fs.writeFileSync(path.join(worktreePath, 'existing.txt'), 'modified content');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff?path=existing.txt`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.diff.includes('modified content'), 'diff should contain new content');
    assert.ok(data.diff.includes('original content'), 'diff should contain old content');
  });

  it('GET /api/sessions/:id/git/diff returns staged diff', async () => {
    fs.writeFileSync(path.join(worktreePath, 'existing.txt'), 'staged content');
    execSync('git add existing.txt', { cwd: worktreePath });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff?path=existing.txt&staged=true`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.diff.includes('staged content'));
  });

  it('GET /api/sessions/:id/git/diff returns empty diff for clean file', async () => {
    // Reset staged changes
    execSync('git reset HEAD existing.txt', { cwd: worktreePath });
    execSync('git checkout -- existing.txt', { cwd: worktreePath });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff?path=existing.txt`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.diff, '', 'diff should be empty for clean file');
  });
});

describe('Git API - Discard', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create an initial file
    fs.writeFileSync(path.join(tempDir, 'discard-me.txt'), 'original');
    execSync('git add discard-me.txt && git -c commit.gpgsign=false commit -m "add file"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-discard-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'discard-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/sessions/:id/git/discard reverts file changes', async () => {
    // Modify the file
    fs.writeFileSync(path.join(worktreePath, 'discard-me.txt'), 'modified');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['discard-me.txt'] }),
    });
    assert.strictEqual(res.status, 200);

    // Verify file is reverted
    const content = fs.readFileSync(path.join(worktreePath, 'discard-me.txt'), 'utf-8');
    assert.strictEqual(content, 'original');
  });

  it('POST /api/sessions/:id/git/discard rejects path traversal', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['../../etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });
});

describe('Git API - Log', () => {
  let server, baseUrl, tempDir, sessionId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create multiple commits
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(tempDir, `file-${i}.txt`), `content ${i}`);
      execSync(`git add file-${i}.txt && git -c commit.gpgsign=false commit -m "commit ${i}"`, {
        cwd: tempDir,
        env: { ...process.env, ...gitEnv },
      });
    }

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-log-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'log-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('GET /api/sessions/:id/git/log returns commit history', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.commits), 'should return commits array');
    assert.ok(data.commits.length >= 4, `should have at least 4 commits (init + 3), got ${data.commits.length}`);

    const latest = data.commits[0];
    assert.ok(latest.hash, 'commit should have hash');
    assert.ok(latest.shortHash, 'commit should have shortHash');
    assert.ok(latest.message, 'commit should have message');
    assert.ok(latest.author, 'commit should have author');
    assert.ok(latest.date, 'commit should have date');
  });

  it('GET /api/sessions/:id/git/log respects limit parameter', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log?limit=2`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.commits.length, 2, 'should return only 2 commits');
  });

  it('GET /api/sessions/:id/git/log returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/log`);
    assert.strictEqual(res.status, 404);
  });
});
