// test/git-worktree.test.js
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sanitizeBranchName, validateGitRepo, validateWorktreesDir, createWorktree, removeWorktree, worktreeExists, isWorktreeDirty, WorktreeDirtyCheckError, isWorktreesIgnored } from '../git-worktree.js';

// Set git config for CI environments
const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
}

function createTempRepo() {
  const dir = createTempDir();
  execSync('git init && git commit --allow-empty -m "init"', { cwd: dir, env: { ...process.env, ...gitEnv } });
  return dir;
}

describe('sanitizeBranchName', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    assert.strictEqual(sanitizeBranchName('Fix Auth Bug'), 'fix-auth-bug');
  });

  it('removes special characters', () => {
    assert.strictEqual(sanitizeBranchName('Fix Auth Bug!'), 'fix-auth-bug');
  });

  it('collapses multiple hyphens', () => {
    assert.strictEqual(sanitizeBranchName('Add   spaces'), 'add-spaces');
  });

  it('handles slashes', () => {
    assert.strictEqual(sanitizeBranchName('foo/bar'), 'foo-bar');
  });

  it('converts underscores to hyphens', () => {
    assert.strictEqual(sanitizeBranchName('hello_world'), 'hello-world');
  });

  it('trims whitespace', () => {
    assert.strictEqual(sanitizeBranchName('  trimmed  '), 'trimmed');
  });

  it('handles accented characters by normalizing', () => {
    // Design specifies: "émojis 🚀" → "emojis"
    assert.strictEqual(sanitizeBranchName('émojis 🚀'), 'emojis');
    assert.strictEqual(sanitizeBranchName('café'), 'cafe');
  });

  it('falls back to session for empty result', () => {
    assert.strictEqual(sanitizeBranchName(''), 'session');
    assert.strictEqual(sanitizeBranchName('🚀🚀🚀'), 'session');
  });

  it('truncates to 50 chars', () => {
    const long = 'a'.repeat(60);
    assert.strictEqual(sanitizeBranchName(long).length, 50);
  });

  it('trims leading/trailing hyphens', () => {
    assert.strictEqual(sanitizeBranchName('---test---'), 'test');
  });
});

describe('validateGitRepo', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns valid for normal git repo with commits', async () => {
    tempDir = createTempRepo();
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, true);
  });

  it('returns NOT_GIT_REPO for non-git directory', async () => {
    tempDir = createTempDir();
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'NOT_GIT_REPO');
  });

  it('returns BARE_REPO for bare repository', async () => {
    tempDir = createTempDir();
    execSync('git init --bare', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'BARE_REPO');
  });

  it('returns EMPTY_REPO for repo with no commits', async () => {
    tempDir = createTempDir();
    execSync('git init', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'EMPTY_REPO');
  });
});

describe('validateWorktreesDir (path safety)', () => {
  let tempDir;
  let extraDirs = [];

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    for (const dir of extraDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    extraDirs = [];
  });

  it('returns true for valid .worktrees directory', async () => {
    tempDir = createTempRepo();
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, true);
  });

  it('returns true when .worktrees does not exist yet', async () => {
    tempDir = createTempRepo();
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, true);
  });

  it('returns false when .worktrees is a symlink', async () => {
    tempDir = createTempRepo();
    const outsideDir = createTempDir();
    extraDirs.push(outsideDir);
    fs.symlinkSync(outsideDir, path.join(tempDir, '.worktrees'));
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.message.includes('symlink'));
  });

  it('returns false when .worktrees is a file', async () => {
    tempDir = createTempRepo();
    fs.writeFileSync(path.join(tempDir, '.worktrees'), 'not a directory');
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, false);
  });
});

describe('createWorktree', () => {
  let tempDir;
  let extraDirs = [];

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    for (const dir of extraDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    extraDirs = [];
  });

  it('creates worktree and branch', async () => {
    tempDir = createTempRepo();
    await createWorktree(tempDir, 'test-branch', 'project-123');

    // Verify worktree exists
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(fs.existsSync(worktreePath));

    // Verify branch exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/test-branch'));
  });

  it('rejects path traversal attempts', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => createWorktree(tempDir, '../escape', 'project-123'),
      /INVALID_BRANCH_NAME|Invalid branch name/
    );
  });

  it('rejects when .worktrees is a symlink', async () => {
    tempDir = createTempRepo();
    const outsideDir = createTempDir();
    extraDirs.push(outsideDir);
    fs.symlinkSync(outsideDir, path.join(tempDir, '.worktrees'));

    await assert.rejects(
      () => createWorktree(tempDir, 'test', 'project-123'),
      /symlink/
    );
  });

  it('returns INVALID_BRANCH_NAME for invalid ref format', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => createWorktree(tempDir, 'test..branch', 'project-123'),
      /INVALID_BRANCH_NAME|Invalid branch name/
    );
  });
});

describe('removeWorktree', () => {
  let tempDir;

  function createTempRepoWithWorktree() {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, '.worktrees'));
    execSync('git worktree add -b claude/test-branch .worktrees/test-branch', {
      cwd: dir,
      env: { ...process.env, ...gitEnv }
    });
    return dir;
  }

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('removes worktree but keeps branch when deleteBranch=false', async () => {
    tempDir = createTempRepoWithWorktree();
    await removeWorktree(tempDir, 'test-branch', 'project-123', { deleteBranch: false });

    // Verify worktree is gone
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/test-branch'));
  });

  it('removes worktree and branch when deleteBranch=true', async () => {
    tempDir = createTempRepoWithWorktree();
    await removeWorktree(tempDir, 'test-branch', 'project-123', { deleteBranch: true });

    // Verify worktree is gone
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch is gone
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(!branches.includes('claude/test-branch'));
  });

  it('rejects path traversal in branch name', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => removeWorktree(tempDir, '../escape', 'project-123', { deleteBranch: true }),
      /INVALID_BRANCH_NAME|Invalid branch name/
    );
  });
});

describe('worktreeExists', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns true when worktree is registered with git', async () => {
    tempDir = createTempRepo();
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/exists .worktrees/exists', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv }
    });

    assert.strictEqual(await worktreeExists(tempDir, 'exists'), true);
  });

  it('returns false when worktree is not registered', async () => {
    tempDir = createTempRepo();
    assert.strictEqual(await worktreeExists(tempDir, 'missing'), false);
  });

  it('returns false when directory exists but is not a registered worktree', async () => {
    tempDir = createTempRepo();
    // Create directory manually without git worktree add
    fs.mkdirSync(path.join(tempDir, '.worktrees', 'fake'), { recursive: true });
    assert.strictEqual(await worktreeExists(tempDir, 'fake'), false);
  });
});

describe('isWorktreeDirty', () => {
  let tempDir;

  function createTempRepoWithWorktree() {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, '.worktrees'));
    execSync('git worktree add -b claude/test .worktrees/test', {
      cwd: dir,
      env: { ...process.env, ...gitEnv }
    });
    return dir;
  }

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns false for clean worktree', async () => {
    tempDir = createTempRepoWithWorktree();
    assert.strictEqual(await isWorktreeDirty(tempDir, 'test'), false);
  });

  it('returns true for dirty worktree', async () => {
    tempDir = createTempRepoWithWorktree();
    fs.writeFileSync(path.join(tempDir, '.worktrees', 'test', 'newfile.txt'), 'content');
    assert.strictEqual(await isWorktreeDirty(tempDir, 'test'), true);
  });

  it('throws WorktreeDirtyCheckError when worktree does not exist', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => isWorktreeDirty(tempDir, 'nonexistent'),
      WorktreeDirtyCheckError
    );
  });
});

describe('isWorktreesIgnored', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns true when .worktrees/ is in .gitignore', async () => {
    tempDir = createTempRepo();
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.worktrees/\n');
    assert.strictEqual(await isWorktreesIgnored(tempDir), true);
  });

  it('returns true when .worktrees is in .gitignore (without slash)', async () => {
    tempDir = createTempRepo();
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.worktrees\n');
    assert.strictEqual(await isWorktreesIgnored(tempDir), true);
  });

  it('returns false when .worktrees/ is not in .gitignore', async () => {
    tempDir = createTempRepo();
    assert.strictEqual(await isWorktreesIgnored(tempDir), false);
  });
});

describe('Concurrency', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('handles concurrent worktree creation safely', async () => {
    tempDir = createTempRepo();
    const projectId = 'test-project';

    // Try to create multiple worktrees concurrently
    const results = await Promise.allSettled([
      createWorktree(tempDir, 'branch-1', projectId),
      createWorktree(tempDir, 'branch-2', projectId),
      createWorktree(tempDir, 'branch-3', projectId),
    ]);

    // All should succeed (mutex ensures sequential execution)
    const successes = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(successes.length, 3);

    // Verify all worktrees exist
    assert.ok(await worktreeExists(tempDir, 'branch-1'));
    assert.ok(await worktreeExists(tempDir, 'branch-2'));
    assert.ok(await worktreeExists(tempDir, 'branch-3'));
  });
});
