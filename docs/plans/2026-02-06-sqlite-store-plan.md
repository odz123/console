# SQLite Store Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragile `projects.json` flat file with SQLite via `better-sqlite3`, stored at `~/.claude-console/data.db`, with granular CRUD methods that fail fast on errors.

**Architecture:** `store.js` exports a `createStore(dbPath?)` factory that returns an object with CRUD methods backed by SQLite. `server.js` calls `createStore()` (defaults to `~/.claude-console/data.db`) in production and `createStore(':memory:')` in test mode. All 15 `persist()` call sites become individual store method calls. The in-memory `data` object is removed entirely.

**Tech Stack:** `better-sqlite3` (sync SQLite bindings for Node.js)

**Design doc:** `docs/plans/2026-02-06-sqlite-store-design.md`

---

### Task 1: Install better-sqlite3

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `npm install better-sqlite3`

**Step 2: Verify it installed**

Run: `node -e "import('better-sqlite3').then(m => console.log('OK', typeof m.default))"`
Expected: `OK function`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 dependency"
```

---

### Task 2: Rewrite store.js — Database Setup

**Files:**
- Rewrite: `store.js`
- Rewrite: `test/store.test.js`

**Step 1: Write the failing test for createStore and schema**

Replace `test/store.test.js` entirely:

```js
// test/store.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from '../store.js';

describe('Store: database setup', () => {
  it('createStore returns an object with expected methods', () => {
    const store = createStore(':memory:');
    assert.strictEqual(typeof store.getProjects, 'function');
    assert.strictEqual(typeof store.getProject, 'function');
    assert.strictEqual(typeof store.createProject, 'function');
    assert.strictEqual(typeof store.deleteProject, 'function');
    assert.strictEqual(typeof store.getSessions, 'function');
    assert.strictEqual(typeof store.getSession, 'function');
    assert.strictEqual(typeof store.createSession, 'function');
    assert.strictEqual(typeof store.updateSession, 'function');
    assert.strictEqual(typeof store.deleteSession, 'function');
    assert.strictEqual(typeof store.getAll, 'function');
    assert.strictEqual(typeof store.close, 'function');
  });

  it('getProjects returns empty array on fresh db', () => {
    const store = createStore(':memory:');
    assert.deepStrictEqual(store.getProjects(), []);
  });

  it('getAll returns empty projects and sessions on fresh db', () => {
    const store = createStore(':memory:');
    assert.deepStrictEqual(store.getAll(), { projects: [], sessions: [] });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `createStore` is not exported from `store.js`

**Step 3: Write the new store.js with schema setup and empty method stubs**

Replace `store.js` entirely:

```js
// store.js — SQLite-backed store via better-sqlite3
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.claude-console');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'data.db');

function rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    claudeSessionId: row.claude_session_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createStore(dbPath) {
  if (!dbPath) {
    dbPath = DEFAULT_DB_PATH;
  }

  // Ensure directory exists for non-memory databases
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
  `);

  // Prepared statements
  const stmts = {
    getProjects: db.prepare('SELECT * FROM projects ORDER BY created_at ASC'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    insertProject: db.prepare('INSERT INTO projects (id, name, cwd, created_at) VALUES (@id, @name, @cwd, @createdAt)'),
    deleteProjectSessions: db.prepare('DELETE FROM sessions WHERE project_id = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    getSessions: db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC'),
    getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at ASC'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (id, project_id, name, branch_name, worktree_path, claude_session_id, status, created_at) VALUES (@id, @projectId, @name, @branchName, @worktreePath, @claudeSessionId, @status, @createdAt)'
    ),
    updateSession: db.prepare('UPDATE sessions SET status = @status, claude_session_id = @claudeSessionId WHERE id = @id'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  };

  return {
    getProjects() {
      return stmts.getProjects.all().map(rowToProject);
    },

    getProject(id) {
      const row = stmts.getProject.get(id);
      return row ? rowToProject(row) : undefined;
    },

    createProject({ id, name, cwd, createdAt }) {
      stmts.insertProject.run({ id, name, cwd, createdAt });
      return this.getProject(id);
    },

    deleteProject(id) {
      stmts.deleteProjectSessions.run(id);
      stmts.deleteProject.run(id);
    },

    getSessions(projectId) {
      return stmts.getSessions.all(projectId).map(rowToSession);
    },

    getSession(id) {
      const row = stmts.getSession.get(id);
      return row ? rowToSession(row) : undefined;
    },

    createSession({ id, projectId, name, branchName, worktreePath, claudeSessionId, status, createdAt }) {
      stmts.insertSession.run({
        id,
        projectId,
        name,
        branchName: branchName ?? null,
        worktreePath: worktreePath ?? null,
        claudeSessionId: claudeSessionId ?? null,
        status: status ?? 'running',
        createdAt,
      });
      return this.getSession(id);
    },

    updateSession(id, fields) {
      const current = this.getSession(id);
      if (!current) return undefined;
      stmts.updateSession.run({
        id,
        status: fields.status ?? current.status,
        claudeSessionId: fields.claudeSessionId !== undefined ? fields.claudeSessionId : current.claudeSessionId,
      });
      return this.getSession(id);
    },

    deleteSession(id) {
      stmts.deleteSession.run(id);
    },

    getAll() {
      return {
        projects: this.getProjects(),
        sessions: stmts.getAllSessions.all().map(rowToSession),
      };
    },

    close() {
      db.close();
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add store.js test/store.test.js
git commit -m "feat: rewrite store.js with SQLite backend (schema + setup)"
```

---

### Task 3: Store Tests — Project CRUD

**Files:**
- Modify: `test/store.test.js`

**Step 1: Add project CRUD tests**

Append to `test/store.test.js`:

```js
describe('Store: project CRUD', () => {
  it('createProject and getProject', () => {
    const store = createStore(':memory:');
    const project = store.createProject({
      id: 'p1',
      name: 'test-proj',
      cwd: '/tmp/test',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(project.id, 'p1');
    assert.strictEqual(project.name, 'test-proj');
    assert.strictEqual(project.cwd, '/tmp/test');
    assert.strictEqual(project.createdAt, '2026-02-06T00:00:00.000Z');

    const fetched = store.getProject('p1');
    assert.deepStrictEqual(fetched, project);
  });

  it('getProject returns undefined for missing id', () => {
    const store = createStore(':memory:');
    assert.strictEqual(store.getProject('nonexistent'), undefined);
  });

  it('getProjects returns all projects ordered by createdAt', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p2', name: 'second', cwd: '/b', createdAt: '2026-02-06T01:00:00.000Z' });
    store.createProject({ id: 'p1', name: 'first', cwd: '/a', createdAt: '2026-02-06T00:00:00.000Z' });
    const projects = store.getProjects();
    assert.strictEqual(projects.length, 2);
    assert.strictEqual(projects[0].id, 'p1');
    assert.strictEqual(projects[1].id, 'p2');
  });

  it('deleteProject removes project and its sessions', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'proj', cwd: '/tmp', createdAt: '2026-02-06T00:00:00.000Z' });
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    store.deleteProject('p1');
    assert.strictEqual(store.getProject('p1'), undefined);
    assert.strictEqual(store.getSession('s1'), undefined);
  });

  it('createProject throws on duplicate id', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'a', cwd: '/a', createdAt: '2026-02-06T00:00:00.000Z' });
    assert.throws(() => {
      store.createProject({ id: 'p1', name: 'b', cwd: '/b', createdAt: '2026-02-06T00:00:00.000Z' });
    });
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (all tests)

**Step 3: Commit**

```bash
git add test/store.test.js
git commit -m "test: add project CRUD tests for SQLite store"
```

---

### Task 4: Store Tests — Session CRUD

**Files:**
- Modify: `test/store.test.js`

**Step 1: Add session CRUD tests**

Append to `test/store.test.js`:

```js
describe('Store: session CRUD', () => {
  function storeWithProject() {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'proj', cwd: '/tmp', createdAt: '2026-02-06T00:00:00.000Z' });
    return store;
  }

  it('createSession and getSession', () => {
    const store = storeWithProject();
    const session = store.createSession({
      id: 's1', projectId: 'p1', name: 'my-session',
      branchName: 'my-session-abc1234', worktreePath: '.worktrees/my-session-abc1234',
      claudeSessionId: null, status: 'running',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(session.id, 's1');
    assert.strictEqual(session.projectId, 'p1');
    assert.strictEqual(session.name, 'my-session');
    assert.strictEqual(session.branchName, 'my-session-abc1234');
    assert.strictEqual(session.worktreePath, '.worktrees/my-session-abc1234');
    assert.strictEqual(session.claudeSessionId, null);
    assert.strictEqual(session.status, 'running');

    const fetched = store.getSession('s1');
    assert.deepStrictEqual(fetched, session);
  });

  it('getSession returns undefined for missing id', () => {
    const store = storeWithProject();
    assert.strictEqual(store.getSession('nonexistent'), undefined);
  });

  it('getSessions returns sessions for a project ordered by createdAt', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's2', projectId: 'p1', name: 'second', branchName: 'b2',
      worktreePath: '.worktrees/b2', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T01:00:00.000Z',
    });
    store.createSession({
      id: 's1', projectId: 'p1', name: 'first', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const sessions = store.getSessions('p1');
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(sessions[0].id, 's1');
    assert.strictEqual(sessions[1].id, 's2');
  });

  it('updateSession updates status', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const updated = store.updateSession('s1', { status: 'exited' });
    assert.strictEqual(updated.status, 'exited');
    assert.strictEqual(store.getSession('s1').status, 'exited');
  });

  it('updateSession updates claudeSessionId', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const updated = store.updateSession('s1', { claudeSessionId: 'uuid-abc-123' });
    assert.strictEqual(updated.claudeSessionId, 'uuid-abc-123');
    assert.strictEqual(updated.status, 'running'); // unchanged
  });

  it('updateSession returns undefined for missing id', () => {
    const store = storeWithProject();
    assert.strictEqual(store.updateSession('nonexistent', { status: 'exited' }), undefined);
  });

  it('deleteSession removes session', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    store.deleteSession('s1');
    assert.strictEqual(store.getSession('s1'), undefined);
  });

  it('getAll returns all projects and sessions', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const all = store.getAll();
    assert.strictEqual(all.projects.length, 1);
    assert.strictEqual(all.sessions.length, 1);
    assert.strictEqual(all.projects[0].id, 'p1');
    assert.strictEqual(all.sessions[0].id, 's1');
  });

  it('createSession with nullable fields', () => {
    const store = storeWithProject();
    const session = store.createSession({
      id: 's1', projectId: 'p1', name: 'no-worktree',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(session.branchName, null);
    assert.strictEqual(session.worktreePath, null);
    assert.strictEqual(session.claudeSessionId, null);
    assert.strictEqual(session.status, 'running');
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (all tests)

**Step 3: Commit**

```bash
git add test/store.test.js
git commit -m "test: add session CRUD tests for SQLite store"
```

---

### Task 5: Wire up server.js — Imports and Initialization

**Files:**
- Modify: `server.js`

This task replaces the import, initialization, and helper functions. The next task handles all the endpoint mutations.

**Step 1: Replace imports and initialization**

In `server.js`, change line 11:

```js
// OLD
import { load, save } from './store.js';
// NEW
import { createStore } from './store.js';
```

Change line 37:

```js
// OLD
let data = testMode ? { projects: [], sessions: [] } : load();
// NEW
const store = testMode ? createStore(':memory:') : createStore();
```

**Step 2: Remove the `persist()` helper**

Delete lines 92-94:

```js
// DELETE THIS
  function persist() {
    if (!testMode) save(data);
  }
```

**Step 3: Rewrite `broadcastState()`**

Replace lines 106-118:

```js
  function broadcastState() {
    const { projects, sessions } = store.getAll();
    const msg = JSON.stringify({
      type: 'state',
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }
```

**Step 4: Rewrite `spawnSession()`**

Replace the `spawnSession` function (lines 120-183). Key changes: read project from store, use `store.updateSession` instead of direct mutation.

```js
  async function spawnSession(session) {
    const project = store.getProject(session.projectId);
    if (!project) throw new Error('Project not found for session');

    // Use worktree path if available (new sessions), otherwise project cwd (backward compat)
    let cwd = project.cwd;
    if (session.worktreePath) {
      try {
        cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch (e) {
        const err = new Error(`Invalid worktree path for session: ${e.message}`);
        err.code = e.code || 'INVALID_WORKTREE_PATH';
        throw err;
      }
    }

    const spawnOpts = {
      cwd,
      ...(testMode
        ? { shell: '/bin/bash', args: ['-c', 'sleep 3600'] }
        : session.claudeSessionId
          ? { resumeId: session.claudeSessionId }
          : {}),
    };

    try {
      manager.spawn(session.id, spawnOpts);
    } catch (e) {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      throw e;
    }

    manager.onExit(session.id, () => {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    // Session ID capture (only for real claude).
    if (!testMode) {
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const captureListener = (d) => {
        const match = d.match(uuidRegex);
        if (match) {
          store.updateSession(session.id, { claudeSessionId: match[0] });
          manager.offData(session.id, captureListener);
          broadcastState();
        }
      };
      manager.onData(session.id, captureListener);

      manager.onExit(session.id, () => {
        manager.offData(session.id, captureListener);
      });
    }
  }
```

**Step 5: Verify syntax**

Run: `node --check server.js`
Expected: no errors

**Step 6: Commit**

```bash
git add server.js
git commit -m "refactor: replace store imports and helpers with SQLite store"
```

---

### Task 6: Wire up server.js — REST Endpoints

**Files:**
- Modify: `server.js`

**Step 1: Rewrite GET /api/projects**

Replace the handler (around line 187):

```js
  app.get('/api/projects', (req, res) => {
    const { projects, sessions } = store.getAll();
    res.json({
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
  });
```

**Step 2: Rewrite POST /api/projects**

Replace `data.projects.push(project); persist();` with store call. The project object construction stays the same, but instead of pushing to array:

```js
    // OLD:
    // data.projects.push(project);
    // persist();

    // NEW:
    const project = store.createProject({
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    });

    broadcastState();
    res.status(201).json(project);
```

**Step 3: Rewrite DELETE /api/projects/:id**

Replace the handler. Key change: use `store.getProject()`, `store.getSessions()`, `store.deleteProject()`:

```js
  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });

    // Kill all sessions for this project
    const projectSessions = store.getSessions(req.params.id);
    for (const s of projectSessions) {
      manager.kill(s.id);
      manager.killShell(s.id);
      const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    }

    // Clean up worktrees and branches for all sessions (best-effort)
    for (const s of projectSessions) {
      if (!s.branchName) continue;
      try {
        await removeWorktree(project.cwd, s.branchName, project.id, { deleteBranch: true });
      } catch {
        // Best-effort cleanup - ignore errors
      }
    }

    // Remove sessions and project (deleteProject handles both)
    store.deleteProject(req.params.id);
    broadcastState();
    res.json({ ok: true });
  });
```

**Step 4: Rewrite POST /api/projects/:id/sessions**

Replace the handler. Key changes: use `store.getProject()`, `store.createSession()`, `store.deleteSession()`:

```js
  app.post('/api/projects/:id/sessions', async (req, res) => {
    const project = store.getProject(req.params.id);
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

    // Generate session ID and branch name first
    const sessionId = crypto.randomUUID();
    const branchName = `${sanitizeBranchName(name)}-${sessionId.slice(0, 7)}`;
    const worktreePath = `.worktrees/${branchName}`;

    // Create worktree
    try {
      await createWorktree(project.cwd, branchName, project.id);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        code: e.code || 'WORKTREE_FAILED',
      });
    }

    // Check if .worktrees is in .gitignore
    let worktreeWarning = null;
    try {
      const isIgnored = await isWorktreesIgnored(project.cwd);
      if (!isIgnored) {
        worktreeWarning = 'Warning: .worktrees/ is not in .gitignore. Add it to avoid committing worktree files.';
      }
    } catch {
      // Ignore check errors
    }

    const session = store.createSession({
      id: sessionId,
      projectId: project.id,
      name,
      branchName,
      worktreePath,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    try {
      await spawnSession(session);
    } catch (e) {
      // Clean up worktree on spawn failure
      try {
        await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore cleanup errors
      }
      store.deleteSession(session.id);
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    const response = { ...session, alive: true };
    if (worktreeWarning) {
      response.warning = worktreeWarning;
    }
    res.status(201).json(response);
  });
```

**Step 5: Rewrite DELETE /api/sessions/:id**

Replace the handler. Key changes: `store.getSession()`, `store.getProject()` (via session.projectId), `store.deleteSession()`:

```js
  app.delete('/api/sessions/:id', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

    // Check for dirty worktree (if session has one and not forcing)
    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to delete anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to delete anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    manager.kill(session.id);
    manager.killShell(session.id);

    // Remove worktree and branch
    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore removal errors - worktree might already be gone
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();
    res.json({ ok: true });
  });
```

**Step 6: Rewrite POST /api/sessions/:id/archive**

Replace the handler:

```js
  app.post('/api/sessions/:id/archive', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

    // Check for dirty worktree (same as delete - archive also removes worktree)
    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to archive anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to archive anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    manager.kill(session.id);
    manager.killShell(session.id);

    const fullBranchName = session.branchName ? `claude/${session.branchName}` : null;

    // Remove worktree but keep branch
    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors - worktree might already be gone
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();

    res.json({
      ok: true,
      branch: fullBranchName,
      message: fullBranchName
        ? `Session archived. Branch '${fullBranchName}' preserved for recovery.`
        : 'Session archived.',
    });
  });
```

**Step 7: Rewrite POST /api/sessions/:id/restart**

Replace the handler:

```js
  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(400).json({ error: 'Parent project not found' });

    // Validate cwd
    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    // Check worktree exists (if session has one)
    if (session.branchName) {
      const exists = await worktreeExists(project.cwd, session.branchName);
      if (!exists) {
        return res.status(400).json({
          error: 'Worktree no longer exists. Session cannot be restarted.',
          code: 'WORKTREE_MISSING',
        });
      }
    }

    // Always kill — even exited processes remain in PtyManager's map
    manager.kill(session.id);

    store.updateSession(session.id, { status: 'running' });

    // Re-read session after update for spawnSession
    const updatedSession = store.getSession(session.id);

    try {
      await spawnSession(updatedSession);
    } catch (e) {
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    res.json({ ...store.getSession(session.id), alive: true });
  });
```

**Step 8: Verify syntax**

Run: `node --check server.js`
Expected: no errors

**Step 9: Commit**

```bash
git add server.js
git commit -m "refactor: wire up REST endpoints to SQLite store"
```

---

### Task 7: Wire up server.js — WebSocket and Startup

**Files:**
- Modify: `server.js`

**Step 1: Rewrite WebSocket initial state send**

Replace the initial state send in `wss.on('connection')` (around line 535):

```js
    // Send initial state
    const { projects, sessions } = store.getAll();
    safeSend(
      ws,
      JSON.stringify({
        type: 'state',
        projects,
        sessions: sessions.map((s) => ({
          ...s,
          alive: manager.isAlive(s.id),
        })),
      })
    );
```

**Step 2: Rewrite shell-attach session/project lookup**

In the `shell-attach` case (around line 638), replace:

```js
        case 'shell-attach': {
          const { sessionId, cols, rows } = msg;
          console.log('[shell-attach] sessionId:', sessionId, 'cols:', cols, 'rows:', rows);
          const session = store.getSession(sessionId);
          if (!session) { console.log('[shell-attach] session not found'); break; }

          const project = store.getProject(session.projectId);
          if (!project) { console.log('[shell-attach] project not found'); break; }
```

The rest of the shell-attach handler stays the same (it reads `session.worktreePath` from the snapshot).

**Step 3: Rewrite startup resume logic**

Replace the startup block (around line 727):

```js
  // --- Startup: resume running sessions ---

  if (!testMode) {
    const sessions = store.getAll().sessions;
    for (const session of sessions) {
      if (session.status === 'running' && session.claudeSessionId) {
        const project = store.getProject(session.projectId);
        if (!project) {
          store.updateSession(session.id, { status: 'exited' });
          continue;
        }
        try {
          const stat = fs.statSync(project.cwd);
          if (!stat.isDirectory()) throw new Error();
        } catch {
          console.error(`Project cwd missing for ${session.name}, marking exited`);
          store.updateSession(session.id, { status: 'exited' });
          continue;
        }
        try {
          spawnSession(session);
          console.log(`Resumed session: ${session.name}`);
        } catch (e) {
          console.error(`Failed to resume ${session.name}: ${e.message}`);
          store.updateSession(session.id, { status: 'exited' });
        }
      }
    }
  }
```

Note: the old code had a final `persist()` after the loop. That's no longer needed since each `store.updateSession()` writes immediately.

**Step 4: Add store cleanup to server.destroy()**

In the `server.destroy` function, add `store.close()`:

```js
  server.destroy = () => {
    return new Promise((resolve) => {
      manager.destroyAll();
      manager.destroyAllShells();
      store.close();
      wss.close();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      server.close(resolve);
    });
  };
```

**Step 5: Verify syntax**

Run: `node --check server.js`
Expected: no errors

**Step 6: Commit**

```bash
git add server.js
git commit -m "refactor: wire up WebSocket and startup resume to SQLite store"
```

---

### Task 8: Run Full Test Suite

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 2: Syntax check all files**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js`
Expected: No errors

**Step 3: If tests fail, fix issues and re-run**

Common issues to watch for:
- `data.sessions` or `data.projects` references still in server.js (search for `data.` to find stragglers)
- Missing `store.` prefix on method calls
- Session object shape mismatches (camelCase vs snake_case — the rowToSession mapping should handle this)

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from SQLite migration"
```

---

### Task 9: Delete Old projects.json and Smoke Test

**Step 1: Add projects.json to .gitignore**

The file is no longer used. Add to `.gitignore`:

```
projects.json
```

**Step 2: Start server and verify UI**

Run: `npm start`

Use Playwright MCP to navigate to `http://127.0.0.1:3000` and verify:
- Sidebar shows "Projects" header with "+" button
- Main area shows "Add Project" button when no sessions active
- Clicking "+" opens modal with directory browser
- Create a project and session — verify they persist after server restart

**Step 3: Verify data persists across restarts**

1. Stop the server
2. Run `npm start` again
3. Verify the project/session created in step 2 still appear

**Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: add projects.json to gitignore (replaced by SQLite)"
```

---

## Summary of All Store Call Site Mappings

| Old (server.js) | New |
|---|---|
| `load()` at startup | `createStore()` or `createStore(':memory:')` |
| `data.projects` | `store.getProjects()` or `store.getAll().projects` |
| `data.sessions` | `store.getAll().sessions` |
| `data.projects.find(p => p.id === id)` | `store.getProject(id)` |
| `data.projects.findIndex(...)` | `store.getProject(id)` then check undefined |
| `data.sessions.find(s => s.id === id)` | `store.getSession(id)` |
| `data.sessions.findIndex(...)` | `store.getSession(id)` then check undefined |
| `data.sessions.filter(s => s.projectId === id)` | `store.getSessions(projectId)` |
| `data.projects.push(project); persist()` | `store.createProject({...})` |
| `data.sessions.push(session); persist()` | `store.createSession({...})` |
| `data.projects.splice(idx, 1); persist()` | `store.deleteProject(id)` |
| `data.sessions.splice(idx, 1); persist()` | `store.deleteSession(id)` |
| `data.sessions = data.sessions.filter(...); persist()` | `store.deleteProject(id)` (deletes sessions internally) |
| `session.status = 'exited'; persist()` | `store.updateSession(id, { status: 'exited' })` |
| `session.status = 'running'; persist()` | `store.updateSession(id, { status: 'running' })` |
| `session.claudeSessionId = x; persist()` | `store.updateSession(id, { claudeSessionId: x })` |
| `persist()` (standalone) | removed — each mutation writes immediately |
