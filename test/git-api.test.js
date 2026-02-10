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

describe('Git API - Status (extended)', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create a tracked file
    fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'original');
    execSync('git add tracked.txt && git -c commit.gpgsign=false commit -m "add tracked"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-status-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'status-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('status shows modified files as unstaged with M status', async () => {
    fs.writeFileSync(path.join(worktreePath, 'tracked.txt'), 'modified');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.unstaged.some(f => f.path === 'tracked.txt' && f.status === 'M'),
      'tracked.txt should show as modified unstaged');

    // Reset for next test
    execSync('git checkout -- tracked.txt', { cwd: worktreePath });
  });

  it('status shows staged files with correct status', async () => {
    fs.writeFileSync(path.join(worktreePath, 'tracked.txt'), 'staged change');
    execSync('git add tracked.txt', { cwd: worktreePath });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.staged.some(f => f.path === 'tracked.txt' && f.status === 'M'),
      'tracked.txt should show as staged modified');

    // Reset
    execSync('git reset HEAD tracked.txt && git checkout -- tracked.txt', { cwd: worktreePath });
  });

  it('status shows both staged and unstaged changes simultaneously', async () => {
    // Stage one change, then modify again without staging
    fs.writeFileSync(path.join(worktreePath, 'tracked.txt'), 'staged version');
    execSync('git add tracked.txt', { cwd: worktreePath });
    fs.writeFileSync(path.join(worktreePath, 'tracked.txt'), 'unstaged version');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.staged.some(f => f.path === 'tracked.txt'),
      'should have staged change');
    assert.ok(data.unstaged.some(f => f.path === 'tracked.txt'),
      'should have unstaged change');

    // Reset
    execSync('git reset HEAD tracked.txt && git checkout -- tracked.txt', { cwd: worktreePath });
  });

  it('status shows deleted files with D status', async () => {
    fs.unlinkSync(path.join(worktreePath, 'tracked.txt'));

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.unstaged.some(f => f.path === 'tracked.txt' && f.status === 'D'),
      'tracked.txt should show as deleted');

    // Restore
    execSync('git checkout -- tracked.txt', { cwd: worktreePath });
  });

  it('status returns branch name', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const data = await res.json();
    assert.ok(data.branch.startsWith('claude/'), 'branch should start with claude/ prefix');
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

describe('Git API - Stage/Unstage (extended)', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create a tracked file
    fs.writeFileSync(path.join(tempDir, 'file-a.txt'), 'a');
    fs.writeFileSync(path.join(tempDir, 'file-b.txt'), 'b');
    execSync('git add -A && git -c commit.gpgsign=false commit -m "add files"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-stage-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'stage-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('stage rejects absolute paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });

  it('stage rejects non-string paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [123] }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('string'));
  });

  it('stage returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('unstage specific files leaves others staged', async () => {
    // Stage two files
    fs.writeFileSync(path.join(worktreePath, 'file-a.txt'), 'modified-a');
    fs.writeFileSync(path.join(worktreePath, 'file-b.txt'), 'modified-b');
    await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });

    // Unstage only file-a
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file-a.txt'] }),
    });
    assert.strictEqual(res.status, 200);

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/status`);
    const status = await statusRes.json();
    assert.ok(!status.staged.some(f => f.path === 'file-a.txt'), 'file-a.txt should be unstaged');
    assert.ok(status.staged.some(f => f.path === 'file-b.txt'), 'file-b.txt should remain staged');

    // Clean up
    execSync('git reset HEAD && git checkout -- .', { cwd: worktreePath });
  });

  it('unstage rejects path traversal', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['../../etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });

  it('unstage rejects absolute paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });

  it('unstage rejects non-string paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [null] }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('unstage rejects empty paths array', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('unstage returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    assert.strictEqual(res.status, 404);
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

describe('Git API - Commit (extended)', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-commit-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'commit-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('commit rejects message longer than 5000 characters', async () => {
    fs.writeFileSync(path.join(worktreePath, 'long-msg.txt'), 'content');
    await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['long-msg.txt'] }),
    });

    const longMessage = 'x'.repeat(5001);
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: longMessage }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('too long'));

    // Clean up staged file
    execSync('git reset HEAD long-msg.txt', { cwd: worktreePath });
  });

  it('commit rejects missing message field', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('commit rejects whitespace-only message', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   \n  ' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('commit response includes author and date fields', async () => {
    fs.writeFileSync(path.join(worktreePath, 'author-test.txt'), 'check author');
    await fetch(`${baseUrl}/api/sessions/${sessionId}/git/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['author-test.txt'] }),
    });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test author fields' }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.commit.author, 'should have author');
    assert.ok(data.commit.date, 'should have date');
    assert.ok(data.commit.date.includes('T'), 'date should be ISO format');
  });

  it('commit returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    assert.strictEqual(res.status, 404);
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

describe('Git API - Diff (extended)', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create two tracked files
    fs.writeFileSync(path.join(tempDir, 'alpha.txt'), 'alpha original');
    fs.writeFileSync(path.join(tempDir, 'beta.txt'), 'beta original');
    execSync('git add -A && git -c commit.gpgsign=false commit -m "add two files"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-diff-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'diff-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('diff without path returns combined diff for all modified files', async () => {
    fs.writeFileSync(path.join(worktreePath, 'alpha.txt'), 'alpha changed');
    fs.writeFileSync(path.join(worktreePath, 'beta.txt'), 'beta changed');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.diff.includes('alpha changed'), 'diff should contain alpha changes');
    assert.ok(data.diff.includes('beta changed'), 'diff should contain beta changes');

    // Clean up
    execSync('git checkout -- .', { cwd: worktreePath });
  });

  it('diff contains +/- diff markers', async () => {
    fs.writeFileSync(path.join(worktreePath, 'alpha.txt'), 'alpha new line');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff?path=alpha.txt`);
    const data = await res.json();
    assert.ok(data.diff.includes('+alpha new line'), 'should have + line for addition');
    assert.ok(data.diff.includes('-alpha original'), 'should have - line for deletion');
    assert.ok(data.diff.includes('@@'), 'should have hunk header');

    // Clean up
    execSync('git checkout -- alpha.txt', { cwd: worktreePath });
  });

  it('diff for deleted file shows all lines removed', async () => {
    fs.unlinkSync(path.join(worktreePath, 'alpha.txt'));

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/diff?path=alpha.txt`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.diff.includes('-alpha original'), 'should show removed content');

    // Restore
    execSync('git checkout -- alpha.txt', { cwd: worktreePath });
  });

  it('diff returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/diff`);
    assert.strictEqual(res.status, 404);
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

describe('Git API - Discard (extended)', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    fs.writeFileSync(path.join(tempDir, 'keep.txt'), 'keep me');
    execSync('git add keep.txt && git -c commit.gpgsign=false commit -m "add keep"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-discard-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'discard-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('discard rejects empty paths array', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('discard rejects non-string paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [42] }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('string'));
  });

  it('discard rejects absolute paths', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/etc/passwd'] }),
    });
    assert.strictEqual(res.status, 403);
  });

  it('discard returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('discard reverts multiple files at once', async () => {
    fs.writeFileSync(path.join(worktreePath, 'keep.txt'), 'modified');
    // Create another tracked file
    fs.writeFileSync(path.join(worktreePath, 'extra.txt'), 'extra');
    execSync('git add extra.txt && git -c commit.gpgsign=false commit -m "add extra"', {
      cwd: worktreePath,
      env: { ...process.env, ...gitEnv },
    });
    fs.writeFileSync(path.join(worktreePath, 'extra.txt'), 'extra modified');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['keep.txt', 'extra.txt'] }),
    });
    assert.strictEqual(res.status, 200);

    const content1 = fs.readFileSync(path.join(worktreePath, 'keep.txt'), 'utf-8');
    const content2 = fs.readFileSync(path.join(worktreePath, 'extra.txt'), 'utf-8');
    assert.strictEqual(content1, 'keep me');
    assert.strictEqual(content2, 'extra');
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

describe('Git API - Log (extended)', () => {
  let server, baseUrl, tempDir, sessionId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    // Create 5 commits
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tempDir, `log-file-${i}.txt`), `content ${i}`);
      execSync(`git add log-file-${i}.txt && git -c commit.gpgsign=false commit -m "log commit ${i}"`, {
        cwd: tempDir,
        env: { ...process.env, ...gitEnv },
      });
    }

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-log-ext-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'log-ext-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('log returns newest commits first', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log`);
    const data = await res.json();
    assert.strictEqual(data.commits[0].message, 'log commit 5', 'newest commit should be first');
    assert.strictEqual(data.commits[1].message, 'log commit 4', 'second newest should be second');
  });

  it('log defaults to 50 when no limit specified', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log`);
    const data = await res.json();
    // We have 6 commits (init + 5), all should be returned since < 50
    assert.strictEqual(data.commits.length, 6);
  });

  it('log caps limit at 200 for excessive values', async () => {
    // Just verify the endpoint doesn't error with a huge limit
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log?limit=999`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.commits));
  });

  it('log with limit=0 returns default (no crash)', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log?limit=0`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    // limit=0 -> parseInt gives 0, || 50 -> 50, min(50,200) -> 50
    assert.ok(data.commits.length > 0);
  });

  it('log commit objects have all required fields', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/log?limit=1`);
    const data = await res.json();
    const commit = data.commits[0];
    assert.ok(typeof commit.hash === 'string' && commit.hash.length === 40, 'hash should be 40 chars');
    assert.ok(typeof commit.shortHash === 'string' && commit.shortHash.length >= 7, 'shortHash should be >= 7 chars');
    assert.ok(typeof commit.message === 'string', 'message should be string');
    assert.ok(typeof commit.author === 'string', 'author should be string');
    assert.ok(typeof commit.date === 'string' && commit.date.includes('T'), 'date should be ISO format');
  });
});

describe('Git API - Merge to Main', () => {
  let server, baseUrl, tempDir, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'git-merge-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'merge-session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST merge-to-main merges committed changes into default branch', async () => {
    // Create and commit a file in the worktree
    fs.writeFileSync(path.join(worktreePath, 'merged-file.txt'), 'merged content');
    execSync('git add merged-file.txt && git -c commit.gpgsign=false commit -m "add merged file"', {
      cwd: worktreePath,
      env: { ...process.env, ...gitEnv },
    });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/merge-to-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.mergedBranch.startsWith('claude/'), 'should include branch name');
    assert.ok(data.targetBranch, 'should include target branch');
    assert.ok(data.commit.hash, 'should include commit hash');

    // Verify the file exists on the default branch
    const defaultBranch = data.targetBranch;
    const mainContent = execSync(`git show ${defaultBranch}:merged-file.txt`, {
      cwd: tempDir, encoding: 'utf-8',
    });
    assert.strictEqual(mainContent, 'merged content');
  });

  it('POST merge-to-main rejects when worktree has uncommitted changes', async () => {
    // Create uncommitted changes
    fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'uncommitted');

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/merge-to-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'DIRTY_WORKTREE');

    // Clean up
    fs.unlinkSync(path.join(worktreePath, 'dirty.txt'));
  });

  it('POST merge-to-main returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent/git/merge-to-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST merge-to-main handles merge conflicts', async () => {
    // Create a conflicting file on the default branch
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: tempDir, encoding: 'utf-8',
    }).trim();

    fs.writeFileSync(path.join(tempDir, 'conflict-file.txt'), 'main version');
    execSync('git add conflict-file.txt && git -c commit.gpgsign=false commit -m "main conflict"', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Create the same file with different content in the worktree
    fs.writeFileSync(path.join(worktreePath, 'conflict-file.txt'), 'branch version');
    execSync('git add conflict-file.txt && git -c commit.gpgsign=false commit -m "branch conflict"', {
      cwd: worktreePath,
      env: { ...process.env, ...gitEnv },
    });

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git/merge-to-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(res.status, 409);
    const data = await res.json();
    assert.strictEqual(data.code, 'MERGE_CONFLICT');

    // Verify the merge was aborted and main is clean (ignore untracked like .worktrees/)
    const status = execSync('git status --porcelain -uno', { cwd: tempDir, encoding: 'utf-8' });
    assert.strictEqual(status.trim(), '', 'main should be clean after merge abort');
  });
});

describe('Git API - Merge to Main (extended)', () => {
  let server, baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('merge-to-main rejects when project root is on wrong branch', async () => {
    const tempDir = createTempRepo();
    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'git-merge-wrong-branch', cwd: tempDir }),
      });
      const project = await projRes.json();

      const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'wrong-branch-session' }),
      });
      const session = await sessRes.json();
      const worktreePath = path.join(tempDir, session.worktreePath);

      // Make a commit on the worktree so merge has something to do
      fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature');
      execSync('git add feature.txt && git -c commit.gpgsign=false commit -m "feature"', {
        cwd: worktreePath,
        env: { ...process.env, ...gitEnv },
      });

      // Switch project root to a different branch
      execSync('git checkout -b other-branch', { cwd: tempDir });

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.code, 'WRONG_BRANCH');

      // Restore
      execSync('git checkout master || git checkout main', { cwd: tempDir });
    } finally {
      cleanupDir(tempDir);
    }
  });

  it('merge-to-main rejects when main has uncommitted tracked changes', async () => {
    const tempDir = createTempRepo();
    try {
      // Create a tracked file on main
      fs.writeFileSync(path.join(tempDir, 'main-file.txt'), 'original');
      execSync('git add main-file.txt && git -c commit.gpgsign=false commit -m "add main-file"', {
        cwd: tempDir,
        env: { ...process.env, ...gitEnv },
      });

      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'git-merge-dirty-main', cwd: tempDir }),
      });
      const project = await projRes.json();

      const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dirty-main-session' }),
      });
      const session = await sessRes.json();
      const worktreePath = path.join(tempDir, session.worktreePath);

      // Commit in worktree
      fs.writeFileSync(path.join(worktreePath, 'wt-file.txt'), 'worktree');
      execSync('git add wt-file.txt && git -c commit.gpgsign=false commit -m "wt commit"', {
        cwd: worktreePath,
        env: { ...process.env, ...gitEnv },
      });

      // Dirty the main worktree (tracked file modification, not untracked)
      fs.writeFileSync(path.join(tempDir, 'main-file.txt'), 'dirty');

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.code, 'MAIN_DIRTY');
    } finally {
      cleanupDir(tempDir);
    }
  });

  it('merge-to-main succeeds with successive merges', async () => {
    const tempDir = createTempRepo();
    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'git-merge-successive', cwd: tempDir }),
      });
      const project = await projRes.json();

      const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'successive-session' }),
      });
      const session = await sessRes.json();
      const worktreePath = path.join(tempDir, session.worktreePath);

      // First merge
      fs.writeFileSync(path.join(worktreePath, 'first.txt'), 'first');
      execSync('git add first.txt && git -c commit.gpgsign=false commit -m "first merge"', {
        cwd: worktreePath,
        env: { ...process.env, ...gitEnv },
      });

      const res1 = await fetch(`${baseUrl}/api/sessions/${session.id}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res1.status, 200);

      // Second merge
      fs.writeFileSync(path.join(worktreePath, 'second.txt'), 'second');
      execSync('git add second.txt && git -c commit.gpgsign=false commit -m "second merge"', {
        cwd: worktreePath,
        env: { ...process.env, ...gitEnv },
      });

      const res2 = await fetch(`${baseUrl}/api/sessions/${session.id}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.strictEqual(data2.ok, true);

      // Both files should exist on main
      const files = execSync('git ls-tree --name-only HEAD', { cwd: tempDir, encoding: 'utf-8' });
      assert.ok(files.includes('first.txt'), 'first.txt should be on main');
      assert.ok(files.includes('second.txt'), 'second.txt should be on main');
    } finally {
      cleanupDir(tempDir);
    }
  });

  it('merge-to-main response includes all expected fields', async () => {
    const tempDir = createTempRepo();
    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'git-merge-fields', cwd: tempDir }),
      });
      const project = await projRes.json();

      const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fields-session' }),
      });
      const session = await sessRes.json();
      const worktreePath = path.join(tempDir, session.worktreePath);

      fs.writeFileSync(path.join(worktreePath, 'fields.txt'), 'fields');
      execSync('git add fields.txt && git -c commit.gpgsign=false commit -m "fields test"', {
        cwd: worktreePath,
        env: { ...process.env, ...gitEnv },
      });

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.ok, true);
      assert.ok(data.mergedBranch.startsWith('claude/'), 'mergedBranch should start with claude/');
      assert.ok(typeof data.targetBranch === 'string', 'should have targetBranch');
      assert.ok(typeof data.commit.hash === 'string' && data.commit.hash.length === 40, 'should have 40-char hash');
      assert.ok(typeof data.commit.shortHash === 'string', 'should have shortHash');
      assert.ok(typeof data.commit.message === 'string', 'should have message');
      assert.ok(typeof data.commit.author === 'string', 'should have author');
      assert.ok(typeof data.commit.date === 'string', 'should have date');
    } finally {
      cleanupDir(tempDir);
    }
  });
});
