# Git Worktree Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add git worktree support so each Claude session runs in an isolated worktree for parallel experimentation.

**Architecture:** New `git-worktree.js` module handles all git operations with per-project mutex for concurrency safety. Server validates repos at project creation, creates worktrees at session creation. Frontend shows branch info and handles archive/delete flows.

**Tech Stack:** Node.js, child_process.execFile, Express REST API, vanilla JS frontend

**Design:** `docs/plans/2026-02-04-worktree-integration-design.md`

**Dex Epic:** `y91ookr7`

**Revision:** v2 - Addresses Codex review feedback (mutex, path safety, error codes, test gaps)

---

## Task 1: Create git-worktree.js Helper Module

**Files:**
- Create: `git-worktree.js`
- Test: `test/git-worktree.test.js`

### Step 1: Write failing tests for sanitizeBranchName

```javascript
// test/git-worktree.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sanitizeBranchName } from '../git-worktree.js';

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
```

### Step 2: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "Cannot find module '../git-worktree.js'"

### Step 3: Implement sanitizeBranchName

```javascript
// git-worktree.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// Per-project mutex map for worktree operations
const projectLocks = new Map();

/**
 * Acquire a lock for worktree operations on a project
 * @param {string} projectId - Project ID
 * @param {number} timeout - Timeout in ms (default 30000)
 * @returns {Promise<() => void>} - Release function
 */
async function acquireProjectLock(projectId, timeout = 30000) {
  const startTime = Date.now();

  while (projectLocks.has(projectId)) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for project lock');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  let releaseFn;
  const lockPromise = new Promise(resolve => { releaseFn = resolve; });
  projectLocks.set(projectId, lockPromise);

  return () => {
    projectLocks.delete(projectId);
    releaseFn();
  };
}

/**
 * Convert session name to branch-safe format (deterministic)
 * @param {string} sessionName - Display name of session
 * @returns {string} - Sanitized branch name
 */
export function sanitizeBranchName(sessionName) {
  let result = sessionName
    // Normalize unicode (é → e + combining accent, then remove combining marks)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Remove remaining non-ASCII characters (emoji, etc)
    .replace(/[^\x00-\x7F]/g, '')
    // Replace non-alphanumeric with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Truncate to 50 chars
    .slice(0, 50)
    // Trim again after truncation (might end with hyphen)
    .replace(/-+$/g, '');

  return result || 'session';
}
```

### Step 4: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 5: Write failing tests for validateGitRepo

Add to `test/git-worktree.test.js`:

```javascript
import { validateGitRepo } from '../git-worktree.js';

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
```

### Step 6: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "validateGitRepo is not a function"

### Step 7: Implement validateGitRepo

Add to `git-worktree.js`:

```javascript
/**
 * Check if directory is a valid git repository (not bare, has commits)
 * @param {string} dir - Directory to check
 * @returns {Promise<{valid: boolean, code?: string, message?: string}>}
 */
export async function validateGitRepo(dir) {
  // Check if it's a git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if it's bare
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-bare-repository'],
      { cwd: dir }
    );
    if (stdout.trim() === 'true') {
      return {
        valid: false,
        code: 'BARE_REPO',
        message: 'Bare repositories are not supported',
      };
    }
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if HEAD exists (has commits)
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'EMPTY_REPO',
      message: 'Repository has no commits. Make an initial commit first.',
    };
  }

  return { valid: true };
}
```

### Step 8: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 9: Write failing tests for validateWorktreesDir (path safety)

Add to `test/git-worktree.test.js`:

```javascript
import { validateWorktreesDir } from '../git-worktree.js';

describe('validateWorktreesDir (path safety)', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
    fs.symlinkSync(outsideDir, path.join(tempDir, '.worktrees'));
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.message.includes('symlink'));
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('returns false when .worktrees is a file', async () => {
    tempDir = createTempRepo();
    fs.writeFileSync(path.join(tempDir, '.worktrees'), 'not a directory');
    const result = await validateWorktreesDir(tempDir);
    assert.strictEqual(result.valid, false);
  });
});
```

### Step 10: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "validateWorktreesDir is not a function"

### Step 11: Implement validateWorktreesDir

Add to `git-worktree.js`:

```javascript
/**
 * Validate that .worktrees directory is safe (not a symlink, is a directory or doesn't exist)
 * @param {string} projectDir - Project root directory
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
export async function validateWorktreesDir(projectDir) {
  const worktreesPath = path.join(projectDir, '.worktrees');

  try {
    const lstat = await fs.promises.lstat(worktreesPath);

    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        message: 'Security violation: .worktrees is a symlink',
      };
    }

    if (!lstat.isDirectory()) {
      return {
        valid: false,
        message: '.worktrees exists but is not a directory',
      };
    }

    // Verify it resolves inside the project
    const resolved = await fs.promises.realpath(worktreesPath);
    // Use path.sep suffix to prevent prefix bypass (e.g., /repo/.worktrees vs /repo/.worktrees-evil)
    if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
      return {
        valid: false,
        message: 'Security violation: .worktrees resolves outside project',
      };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Doesn't exist yet, that's fine
      return { valid: true };
    }
    return {
      valid: false,
      message: `Cannot verify .worktrees: ${err.message}`,
    };
  }

  return { valid: true };
}
```

### Step 12: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 13: Write failing tests for createWorktree

Add to `test/git-worktree.test.js`:

```javascript
import { createWorktree } from '../git-worktree.js';

describe('createWorktree', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
    fs.symlinkSync(outsideDir, path.join(tempDir, '.worktrees'));

    await assert.rejects(
      () => createWorktree(tempDir, 'test', 'project-123'),
      /symlink/
    );

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('returns INVALID_BRANCH_NAME for invalid ref format', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => createWorktree(tempDir, 'test..branch', 'project-123'),
      /INVALID_BRANCH_NAME|Invalid branch name/
    );
  });
});
```

### Step 14: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "createWorktree is not a function"

### Step 15: Implement createWorktree with mutex and path safety

Add to `git-worktree.js`:

```javascript
/**
 * Validate branch name for safety (no path traversal, valid ref format)
 * @param {string} branchName - Branch name to validate
 * @returns {Promise<{valid: boolean, code?: string}>}
 */
async function validateBranchName(branchName) {
  // Reject path traversal
  if (branchName.includes('..') || branchName.includes('/') || branchName.includes('\\')) {
    return { valid: false, code: 'INVALID_BRANCH_NAME' };
  }

  // Validate with git check-ref-format
  try {
    await execFileAsync('git', [
      'check-ref-format',
      '--branch',
      '--',
      `claude/${branchName}`,
    ]);
    return { valid: true };
  } catch {
    return { valid: false, code: 'INVALID_BRANCH_NAME' };
  }
}

/**
 * Create worktree and branch (with path/ref safety checks and mutex)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @param {string} projectId - Project ID for mutex
 * @returns {Promise<void>}
 * @throws {Error} with code property for specific errors
 */
export async function createWorktree(projectDir, branchName, projectId) {
  // Validate branch name
  const branchValidation = await validateBranchName(branchName);
  if (!branchValidation.valid) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = branchValidation.code;
    throw err;
  }

  // Validate .worktrees directory (path safety)
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    const err = new Error(dirValidation.message);
    err.code = 'PATH_SAFETY_VIOLATION';
    throw err;
  }

  // Acquire project lock
  const release = await acquireProjectLock(projectId);

  try {
    const worktreePath = path.join(projectDir, '.worktrees', branchName);
    const fullBranchName = `claude/${branchName}`;

    // Ensure .worktrees directory exists
    const worktreesDir = path.join(projectDir, '.worktrees');
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    // Create worktree with new branch
    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', fullBranchName, '--', worktreePath],
        { cwd: projectDir }
      );
    } catch (err) {
      const error = new Error(`Failed to create worktree: ${err.stderr || err.message}`);
      error.code = 'WORKTREE_FAILED';
      throw error;
    }
  } finally {
    release();
  }
}
```

### Step 16: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 17: Write failing tests for removeWorktree

Add to `test/git-worktree.test.js`:

```javascript
import { removeWorktree } from '../git-worktree.js';

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
```

### Step 18: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "removeWorktree is not a function"

### Step 19: Implement removeWorktree with mutex and path safety

Add to `git-worktree.js`:

```javascript
/**
 * Remove worktree, optionally delete branch (with safety checks and mutex)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @param {string} projectId - Project ID for mutex
 * @param {Object} options
 * @param {boolean} options.deleteBranch - Whether to delete the branch too
 * @returns {Promise<void>}
 */
export async function removeWorktree(projectDir, branchName, projectId, { deleteBranch = false } = {}) {
  // Validate branch name
  const branchValidation = await validateBranchName(branchName);
  if (!branchValidation.valid) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = branchValidation.code;
    throw err;
  }

  // Acquire project lock
  const release = await acquireProjectLock(projectId);

  try {
    const worktreePath = path.join(projectDir, '.worktrees', branchName);
    const fullBranchName = `claude/${branchName}`;

    // Verify worktree path is inside .worktrees (path safety)
    // Use path.sep suffix to prevent prefix bypass
    const worktreesDir = path.join(projectDir, '.worktrees');
    const resolvedWorktree = await fs.promises.realpath(worktreePath).catch(() => worktreePath);
    if (!resolvedWorktree.startsWith(worktreesDir + path.sep) && resolvedWorktree !== worktreesDir) {
      throw new Error('Path safety violation: worktree path escapes .worktrees/');
    }

    // Remove worktree
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', '--', worktreePath],
        { cwd: projectDir }
      );
    } catch (err) {
      // Worktree might already be removed manually
      if (!err.stderr?.includes('is not a working tree') && !err.stderr?.includes('is not a valid')) {
        throw new Error(`Failed to remove worktree: ${err.stderr || err.message}`);
      }
    }

    // Delete branch if requested
    if (deleteBranch) {
      try {
        await execFileAsync(
          'git',
          ['branch', '-D', '--', fullBranchName],
          { cwd: projectDir }
        );
      } catch (err) {
        // Branch might already be deleted
        if (!err.stderr?.includes('not found')) {
          throw new Error(`Failed to delete branch: ${err.stderr || err.message}`);
        }
      }
    }
  } finally {
    release();
  }
}
```

### Step 20: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 21: Write failing tests for worktreeExists (using git worktree list)

Add to `test/git-worktree.test.js`:

```javascript
import { worktreeExists } from '../git-worktree.js';

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
```

### Step 22: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "worktreeExists is not a function"

### Step 23: Implement worktreeExists using git worktree list

Add to `git-worktree.js`:

```javascript
/**
 * Check if worktree is registered with git (not just filesystem check)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 */
export async function worktreeExists(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);

  try {
    // Use git worktree list to verify it's a real registered worktree
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectDir }
    );

    // Parse output to find our worktree
    const resolvedPath = await fs.promises.realpath(worktreePath).catch(() => worktreePath);
    return stdout.includes(`worktree ${resolvedPath}`);
  } catch {
    return false;
  }
}
```

### Step 24: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 25: Write failing tests for isWorktreeDirty (with error handling)

Add to `test/git-worktree.test.js`:

```javascript
import { isWorktreeDirty, WorktreeDirtyCheckError } from '../git-worktree.js';

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
```

### Step 26: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "isWorktreeDirty is not a function"

### Step 27: Implement isWorktreeDirty with proper error handling

Add to `git-worktree.js`:

```javascript
/**
 * Error thrown when dirty check cannot be performed
 */
export class WorktreeDirtyCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorktreeDirtyCheckError';
  }
}

/**
 * Check if worktree has uncommitted changes
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 * @throws {WorktreeDirtyCheckError} when check cannot be performed
 */
export async function isWorktreeDirty(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath }
    );
    return stdout.trim().length > 0;
  } catch (err) {
    // Don't silently return false - throw so caller knows check failed
    throw new WorktreeDirtyCheckError(
      `Cannot check dirty status: ${err.stderr || err.message}`
    );
  }
}
```

### Step 28: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 29: Write failing tests for isWorktreesIgnored

Add to `test/git-worktree.test.js`:

```javascript
import { isWorktreesIgnored } from '../git-worktree.js';

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
```

### Step 30: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "isWorktreesIgnored is not a function"

### Step 31: Implement isWorktreesIgnored

Add to `git-worktree.js`:

```javascript
/**
 * Check if .worktrees/ is in .gitignore
 * @param {string} projectDir - Project root directory
 * @returns {Promise<boolean>}
 */
export async function isWorktreesIgnored(projectDir) {
  // Check both .worktrees and .worktrees/ patterns
  for (const pattern of ['.worktrees', '.worktrees/']) {
    try {
      await execFileAsync(
        'git',
        ['check-ignore', '-q', '--', pattern],
        { cwd: projectDir }
      );
      return true;
    } catch {
      // Not ignored by this pattern, try next
    }
  }
  return false;
}
```

### Step 32: Run all git-worktree tests to verify they pass

Run: `node --test test/git-worktree.test.js`
Expected: All PASS

### Step 33: Write test for concurrent operations (race condition)

Add to `test/git-worktree.test.js`:

```javascript
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
```

### Step 34: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 35: Commit

```bash
git add git-worktree.js test/git-worktree.test.js
git commit -m "$(cat <<'EOF'
feat: add git-worktree.js helper module with safety features

- sanitizeBranchName(): normalize unicode, convert to branch-safe format
- validateGitRepo(): check for valid git repo (not bare, has commits)
- validateWorktreesDir(): path safety - reject symlinks, verify containment
- createWorktree(): create worktree with mutex and safety checks
- removeWorktree(): remove worktree with mutex and safety checks
- worktreeExists(): verify via git worktree list (not just filesystem)
- isWorktreeDirty(): throw error if check fails (don't silently return false)
- isWorktreesIgnored(): check both .worktrees and .worktrees/ patterns
- Per-project mutex prevents race conditions
- Path safety: reject symlinks, use path.sep suffix for containment checks
- Ref safety: validate with git check-ref-format, use -- separator
EOF
)"
```

---

## Task 2: Update server.js for Worktree Integration

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

### Step 1: Write failing test for project git validation

Add to `test/server.test.js`:

```javascript
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
}

function createTempRepo() {
  const dir = createTempDir();
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv }
  });
  return dir;
}

describe('Projects API - Git Validation', () => {
  let server;
  let baseUrl;
  let tempDirs = [];

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /api/projects rejects non-git directory', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'not-git', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'NOT_GIT_REPO');
  });

  it('POST /api/projects rejects bare repository', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    execSync('git init --bare', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bare', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'BARE_REPO');
  });

  it('POST /api/projects rejects empty repository', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    execSync('git init', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'EMPTY_REPO');
  });

  it('POST /api/projects accepts valid git repository', async () => {
    const tempDir = createTempRepo();
    tempDirs.push(tempDir);
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'valid', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 201);
  });
});
```

### Step 2: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - non-git directory currently accepted

### Step 3: Add git validation to POST /api/projects

In `server.js`, update imports and handler:

```javascript
// At top of server.js, add import
import {
  validateGitRepo,
  validateWorktreesDir,
  sanitizeBranchName,
  createWorktree,
  removeWorktree,
  worktreeExists,
  isWorktreeDirty,
  isWorktreesIgnored,
  WorktreeDirtyCheckError,
} from './git-worktree.js';

// In POST /api/projects handler, after directory exists check, add:
// Add git repo validation
const gitResult = await validateGitRepo(resolvedCwd);
if (!gitResult.valid) {
  return res.status(400).json({
    error: gitResult.message,
    code: gitResult.code,
  });
}
```

### Step 4: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: Git validation tests PASS

### Step 5: Write failing test for session creation with worktree

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Worktree Creation', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worktree-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates worktree and branch on session creation', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fix Bug' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();

    // branchName should use session ID (first 7 chars)
    assert.ok(session.branchName);
    assert.ok(session.branchName.startsWith('fix-bug-'));
    assert.strictEqual(session.branchName.split('-').pop().length, 7);
    assert.ok(session.worktreePath);

    // Verify worktree exists on disk
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(fullWorktreePath));

    // Verify branch exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));
  });

  it('returns INVALID_BRANCH_NAME for session names that produce invalid branches', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../escape' }),
    });
    // Should fail with INVALID_BRANCH_NAME or WORKTREE_FAILED
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(['INVALID_BRANCH_NAME', 'WORKTREE_FAILED'].includes(data.code));
  });
});
```

### Step 6: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - branchName not set

### Step 7: Update session creation to create worktree

In `server.js`, update `POST /api/projects/:id/sessions`:

```javascript
app.post('/api/projects/:id/sessions', async (req, res) => {
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
  }

  // Validate project cwd still exists
  try {
    const stat = fs.statSync(project.cwd);
    if (!stat.isDirectory()) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Project directory no longer exists' });
  }

  // Generate branch name using session ID (first 7 chars)
  const sessionId = crypto.randomUUID();
  const baseName = sanitizeBranchName(name);
  const shortId = sessionId.slice(0, 7);  // Use session UUID, not random
  const branchName = `${baseName}-${shortId}`;
  const worktreePath = `.worktrees/${branchName}`;

  // Create worktree
  try {
    await createWorktree(project.cwd, branchName, project.id);
  } catch (err) {
    return res.status(400).json({
      error: err.message,
      code: err.code || 'WORKTREE_FAILED',
    });
  }

  // Check if .worktrees is gitignored (non-blocking warning)
  const ignored = await isWorktreesIgnored(project.cwd);

  const session = {
    id: sessionId,
    projectId: project.id,
    name,
    claudeSessionId: null,
    status: 'running',
    createdAt: new Date().toISOString(),
    branchName,
    worktreePath,
  };

  data.sessions.push(session);
  persist();

  try {
    spawnSession(session);
  } catch (e) {
    // Clean up worktree on spawn failure
    try {
      await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: true });
    } catch { /* ignore */ }
    data.sessions.pop();
    persist();
    return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
  }

  broadcastState();

  const response = { ...session, alive: true };
  if (!ignored) {
    response.warning = 'Consider adding .worktrees/ to your .gitignore';
  }
  res.status(201).json(response);
});
```

### Step 8: Update spawnSession to use worktree path

In `server.js`, update `spawnSession`:

```javascript
function spawnSession(session) {
  const project = data.projects.find((p) => p.id === session.projectId);
  if (!project) throw new Error('Project not found for session');

  // Use worktree path if set, otherwise project cwd
  const sessionCwd = session.worktreePath
    ? path.join(project.cwd, session.worktreePath)
    : project.cwd;

  const spawnOpts = {
    cwd: sessionCwd,
    ...(testMode
      ? { shell: '/bin/bash', args: ['-c', 'sleep 3600'] }
      : session.claudeSessionId
        ? { resumeId: session.claudeSessionId }
        : {}),
  };
  // ... rest unchanged
}
```

### Step 9: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 10: Write failing test for restart with missing worktree

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Restart', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'restart-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns WORKTREE_MISSING when worktree was removed', async () => {
    // Create session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'restart-missing' }),
    });
    const session = await createRes.json();

    // Manually remove the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: tempDir });

    // Try to restart
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'WORKTREE_MISSING');
  });
});
```

### Step 11: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - WORKTREE_MISSING not returned

### Step 12: Update restart to check worktree exists

Update `POST /api/sessions/:id/restart` in `server.js`:

```javascript
app.post('/api/sessions/:id/restart', async (req, res) => {
  const session = data.sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const project = data.projects.find((p) => p.id === session.projectId);
  if (!project) return res.status(400).json({ error: 'Parent project not found' });

  // Check worktree exists if session has one
  if (session.branchName) {
    const exists = await worktreeExists(project.cwd, session.branchName);
    if (!exists) {
      return res.status(400).json({
        error: 'Worktree was removed. Delete this session and create a new one.',
        code: 'WORKTREE_MISSING',
      });
    }
  }

  // ... rest of existing restart logic
});
```

### Step 13: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 14: Write failing test for archive endpoint

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Archive', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'archive-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/sessions/:id/archive removes worktree but keeps branch', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-archive' }),
    });
    const session = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.branch);

    // Verify worktree is gone
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(!fs.existsSync(fullWorktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));

    // Verify session is removed from list
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find(s => s.id === session.id));
  });
});
```

### Step 15: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - 404 (endpoint doesn't exist)

### Step 16: Implement archive endpoint

Add to `server.js`:

```javascript
app.post('/api/sessions/:id/archive', async (req, res) => {
  const session = data.sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const project = data.projects.find((p) => p.id === session.projectId);
  if (!project) return res.status(400).json({ error: 'Parent project not found' });

  // Kill the process
  manager.kill(session.id);

  // Remove worktree (keep branch)
  if (session.branchName) {
    try {
      await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
    } catch (err) {
      console.error(`Failed to remove worktree: ${err.message}`);
    }
  }

  // Notify clients
  const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
  for (const ws of clients) {
    safeSend(ws, msg);
  }

  // Remove session from data
  const idx = data.sessions.findIndex((s) => s.id === session.id);
  data.sessions.splice(idx, 1);
  persist();
  broadcastState();

  res.json({
    ok: true,
    branch: session.branchName ? `claude/${session.branchName}` : null,
    message: 'Session archived. Branch preserved for manual recovery.',
  });
});
```

### Step 17: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 18: Write failing test for delete with dirty worktree

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Delete', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns DIRTY_WORKTREE when worktree has uncommitted changes', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dirty-session' }),
    });
    const session = await createRes.json();

    // Make it dirty
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(fullWorktreePath, 'dirty.txt'), 'uncommitted');

    // Try to delete
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'DIRTY_WORKTREE');
  });

  it('DELETE with force=true deletes dirty worktree', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'force-delete' }),
    });
    const session = await createRes.json();

    // Make it dirty
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(fullWorktreePath, 'dirty.txt'), 'uncommitted');

    // Force delete
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}?force=true`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);

    // Verify worktree and branch are gone
    assert.ok(!fs.existsSync(fullWorktreePath));
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(!branches.includes(`claude/${session.branchName}`));
  });

  it('proceeds with delete when dirty check fails (worktree missing)', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'missing-worktree' }),
    });
    const session = await createRes.json();

    // Manually remove worktree
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    execSync(`git worktree remove --force "${fullWorktreePath}"`, { cwd: tempDir });

    // Delete should still succeed (can't check dirty on missing worktree)
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
  });
});
```

### Step 19: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - dirty check not implemented

### Step 20: Update DELETE endpoint with dirty check

Update `DELETE /api/sessions/:id` in `server.js`:

```javascript
app.delete('/api/sessions/:id', async (req, res) => {
  const idx = data.sessions.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const session = data.sessions[idx];
  const project = data.projects.find((p) => p.id === session.projectId);
  const forceDelete = req.query.force === 'true';

  // Check for dirty worktree (unless force)
  if (session.branchName && project && !forceDelete) {
    try {
      const dirty = await isWorktreeDirty(project.cwd, session.branchName);
      if (dirty) {
        return res.status(400).json({
          error: 'Worktree has uncommitted changes. Use force=true to delete anyway.',
          code: 'DIRTY_WORKTREE',
        });
      }
    } catch (err) {
      // WorktreeDirtyCheckError means we can't check - proceed with delete
      // (worktree might be corrupted or missing)
      if (!(err instanceof WorktreeDirtyCheckError)) {
        throw err;
      }
    }
  }

  // Kill the process
  manager.kill(session.id);

  // Remove worktree and branch
  if (session.branchName && project) {
    try {
      await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: true });
    } catch (err) {
      console.error(`Failed to remove worktree: ${err.message}`);
    }
  }

  // Notify clients
  const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
  for (const ws of clients) {
    safeSend(ws, msg);
  }

  // Remove session
  data.sessions.splice(idx, 1);
  persist();
  broadcastState();
  res.json({ ok: true });
});
```

### Step 21: Run all server tests

Run: `node --test test/server.test.js`
Expected: All PASS

### Step 22: Commit

```bash
git add server.js test/server.test.js
git commit -m "$(cat <<'EOF'
feat: integrate worktree support into server

- Validate git repo at project creation (reject bare/empty)
- Create worktree and branch on session creation
- Use session UUID for branch suffix (deterministic)
- Add POST /api/sessions/:id/archive endpoint
- Check worktree exists on restart (return WORKTREE_MISSING)
- Check for dirty worktree on delete (require force=true)
- Handle WorktreeDirtyCheckError gracefully on delete
- Clean up worktree on spawn failure
EOF
)"
```

---

## Task 3: Update Frontend for Worktree UI

(Frontend steps remain the same as original plan - Steps 1-13)

---

## Task 4: Add Integration Tests

**Files:**
- Modify: `test/server.test.js`

### Step 1: Add comprehensive integration tests

Add to `test/server.test.js`:

```javascript
describe('Worktree Integration - Full Lifecycle', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('complete session lifecycle: create → restart → archive → verify', async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lifecycle-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle Test' }),
    });
    const session = await sessRes.json();
    assert.ok(session.branchName);
    assert.ok(session.worktreePath);

    // Verify worktree exists
    const worktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(worktreePath));

    // Create a file in worktree
    fs.writeFileSync(path.join(worktreePath, 'test.txt'), 'test content');

    // Restart session (should work)
    const restartRes = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, {
      method: 'POST',
    });
    assert.strictEqual(restartRes.status, 200);

    // Archive session
    const archiveRes = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    assert.strictEqual(archiveRes.status, 200);
    const archiveData = await archiveRes.json();
    assert.ok(archiveData.branch);

    // Verify worktree is gone
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));

    // Verify session is removed from API
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find(s => s.id === session.id));
  });

  it('delete removes both worktree and branch', async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete-lifecycle', cwd: tempDir }),
    });
    const project = await projRes.json();

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Delete Test' }),
    });
    const session = await sessRes.json();
    const worktreePath = path.join(tempDir, session.worktreePath);

    // Delete session
    const deleteRes = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deleteRes.status, 200);

    // Verify worktree is gone
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch is also gone
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(!branches.includes(`claude/${session.branchName}`));
  });
});
```

### Step 2: Run all tests

Run: `npm test`
Expected: All PASS

### Step 3: Commit

```bash
git add test/server.test.js
git commit -m "test: add comprehensive worktree integration tests"
```

---

## Task 5: Create Documentation

(Documentation steps remain the same as original plan - Steps 1-3)

---

## Summary of Changes from v1

| Issue | Resolution |
|-------|------------|
| Missing per-project mutex | Added `acquireProjectLock()` with 30s timeout |
| Path safety incomplete | Added `validateWorktreesDir()`, use `path.sep` suffix |
| Error code mismatch | `validateBranchName()` returns `code: 'INVALID_BRANCH_NAME'` |
| sanitizeBranchName accent handling | Use `normalize('NFD')` to strip combining marks |
| isWorktreeDirty returns false on error | Throws `WorktreeDirtyCheckError` |
| worktreeExists only checks filesystem | Uses `git worktree list --porcelain` |
| Tests lack git user config | Added `gitEnv` with GIT_AUTHOR/COMMITTER vars |
| git check-ignore pattern | Check both `.worktrees` and `.worktrees/` |
| Branch suffix random UUID | Use session UUID (first 7 chars) |
| Missing test: concurrent ops | Added concurrency test |
| Missing test: restart missing | Added WORKTREE_MISSING test |
| Missing test: invalid branch | Added INVALID_BRANCH_NAME test |
| Missing test: symlink .worktrees | Added symlink security test |
| Missing test: dirty check failure | Added WorktreeDirtyCheckError handling test |

**Total commits:** 6
