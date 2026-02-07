# SQLite Store Migration

Replace `projects.json` flat file with SQLite via `better-sqlite3`.

## Problem

- `projects.json` is relative to code directory — each worktree gets its own copy
- Silent data loss: `load()` returns empty on any read/parse error, next `persist()` overwrites real data
- In-memory state + full-file dump is fragile

## Solution

SQLite database at `~/.claude-console/data.db` with granular CRUD methods.

## Database

**Location:** `~/.claude-console/data.db` (created on first run)

**Pragmas:** `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`

**Schema:**

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  branch_name TEXT,
  worktree_path TEXT,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_project_id ON sessions(project_id);
```

**Notes:**
- No `ON DELETE CASCADE` — server.js needs session rows to clean up worktrees before deletion. Deletion order: fetch sessions → clean up worktrees → delete sessions → delete project.
- `created_at` uses ISO 8601 strings (e.g. `2026-02-06T08:29:00.000Z`) to match existing frontend/API expectations. Caller provides the value via `new Date().toISOString()`, no SQLite defaults.
- `status` defaults to `'running'` matching how sessions are created in server.js.
- `branch_name` and `worktree_path` are nullable (old sessions or test mode may not have them).

## API

```
// Projects
getProjects()                              → [...]
getProject(id)                             → {} | undefined
createProject({ id, name, cwd })           → {}
deleteProject(id)                          → void (deletes sessions first, no cascade)

// Sessions
getSessions(projectId)                     → [...]
getSession(id)                             → {} | undefined
createSession({ id, projectId, name, branchName, worktreePath, status }) → {}
updateSession(id, fields)                  → {}  // status, claudeSessionId, branchName, worktreePath
deleteSession(id)                          → void

// Bulk read (for broadcasting full state to clients)
getAll()                                   → { projects: [...], sessions: [...] }
```

**Return shape:** All methods return plain objects with camelCase keys (`projectId`, `branchName`, `worktreePath`, `claudeSessionId`, `createdAt`) — matching existing API response shapes. The store handles snake_case ↔ camelCase mapping internally.

**Ordering:** `getProjects()` and `getSessions()` return rows ordered by `created_at ASC`.

## Error Handling

**Fail fast, never return empty on error.** This is the core bug we're fixing.

- `openDatabase()` throws if it cannot create/open the DB file or run migrations. Server refuses to start.
- All CRUD methods let SQLite errors propagate (no try/catch that swallows). Server.js endpoint handlers catch and return 500s.
- No fallback to empty data. If the DB is corrupt, the server crashes with a clear error rather than silently losing data.

## Files Changed

1. **store.js** — Complete rewrite to SQLite CRUD
2. **server.js** — Replace in-memory `data` + `persist()` with store calls (~15 sites)
3. **test/store.test.js** — Rewrite tests (in-memory SQLite for isolation)
4. **package.json** — Add `better-sqlite3`

## Unchanged

- REST/WebSocket endpoint signatures
- Frontend code
- pty-manager.js
- API response shapes (camelCase keys, ISO timestamps)

## Not Included

- No migration from old projects.json (start fresh)
- No schema versioning (can add later if needed)
- No backup rotation (SQLite WAL + atomic commits handle durability)

## Constraints

- Single server process (no concurrent writers)
- Sync API (matches existing code patterns)
- Test mode uses in-memory SQLite (`:memory:`)
