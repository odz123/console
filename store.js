// store.js — SQLite-backed store via better-sqlite3
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.claude-console');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'data.db');

function rowToAccount(row) {
  let env = null;
  if (row.env) {
    try { env = JSON.parse(row.env); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider || 'claude',
    env,
    createdAt: row.created_at,
  };
}

function rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
  };
}

function rowToSession(row) {
  let providerOptions = null;
  if (row.provider_options) {
    try { providerOptions = JSON.parse(row.provider_options); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    claudeSessionId: row.claude_session_id,
    provider: row.provider || 'claude',
    providerOptions,
    accountId: row.account_id || null,
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

  // --- Schema versioning & migrations ---
  const CURRENT_SCHEMA_VERSION = 5;

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const versionRow = db.prepare('SELECT version FROM schema_version').get();
  let dbVersion = versionRow ? versionRow.version : 0;

  // Migration 0 -> 1: initial schema
  if (dbVersion < 1) {
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
    dbVersion = 1;
  }

  // Migration 1 -> 2: add provider column to sessions
  if (dbVersion < 2) {
    db.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`);
    dbVersion = 2;
  }

  // Migration 2 -> 3: add provider_options column for provider-specific config (JSON)
  if (dbVersion < 3) {
    db.exec(`ALTER TABLE sessions ADD COLUMN provider_options TEXT`);
    dbVersion = 3;
  }

  // Migration 3 -> 4: add accounts table
  if (dbVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        env TEXT,
        created_at TEXT NOT NULL
      );
    `);
    dbVersion = 4;
  }

  // Migration 4 -> 5: add account_id column to sessions
  if (dbVersion < 5) {
    db.exec(`ALTER TABLE sessions ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL`);
    dbVersion = 5;
  }

  // Upsert schema version
  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  } else if (versionRow.version !== CURRENT_SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
  }

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
      'INSERT INTO sessions (id, project_id, name, branch_name, worktree_path, claude_session_id, provider, provider_options, account_id, status, created_at) VALUES (@id, @projectId, @name, @branchName, @worktreePath, @claudeSessionId, @provider, @providerOptions, @accountId, @status, @createdAt)'
    ),
    updateSession: db.prepare('UPDATE sessions SET status = @status, claude_session_id = @claudeSessionId WHERE id = @id'),
    renameSession: db.prepare('UPDATE sessions SET name = @name WHERE id = @id'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    getSessionWorktreePaths: db.prepare(
      'SELECT worktree_path FROM sessions WHERE project_id = ? AND worktree_path IS NOT NULL'
    ),
    // Account statements
    getAccounts: db.prepare('SELECT * FROM accounts ORDER BY created_at ASC'),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    insertAccount: db.prepare(
      'INSERT INTO accounts (id, name, provider, env, created_at) VALUES (@id, @name, @provider, @env, @createdAt)'
    ),
    updateAccount: db.prepare(
      'UPDATE accounts SET name = @name, provider = @provider, env = @env WHERE id = @id'
    ),
    deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ?'),
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

    deleteProject: db.transaction(function (id) {
      stmts.deleteProjectSessions.run(id);
      stmts.deleteProject.run(id);
    }),

    getSessions(projectId) {
      return stmts.getSessions.all(projectId).map(rowToSession);
    },

    getSession(id) {
      const row = stmts.getSession.get(id);
      return row ? rowToSession(row) : undefined;
    },

    createSession({ id, projectId, name, branchName, worktreePath, claudeSessionId, provider, providerOptions, accountId, status, createdAt }) {
      stmts.insertSession.run({
        id,
        projectId,
        name,
        branchName: branchName ?? null,
        worktreePath: worktreePath ?? null,
        claudeSessionId: claudeSessionId ?? null,
        provider: provider ?? 'claude',
        providerOptions: providerOptions ? JSON.stringify(providerOptions) : null,
        accountId: accountId ?? null,
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

    renameSession(id, name) {
      stmts.renameSession.run({ id, name });
    },

    deleteSession(id) {
      stmts.deleteSession.run(id);
    },

    getSessionWorktreePaths(projectId) {
      return stmts.getSessionWorktreePaths.all(projectId).map(row => row.worktree_path);
    },

    // --- Account methods ---

    getAccounts() {
      return stmts.getAccounts.all().map(rowToAccount);
    },

    getAccount(id) {
      const row = stmts.getAccount.get(id);
      return row ? rowToAccount(row) : undefined;
    },

    createAccount({ id, name, provider, env, createdAt }) {
      stmts.insertAccount.run({
        id,
        name,
        provider: provider ?? 'claude',
        env: env ? JSON.stringify(env) : null,
        createdAt,
      });
      return this.getAccount(id);
    },

    updateAccount(id, { name, provider, env }) {
      const current = this.getAccount(id);
      if (!current) return undefined;
      stmts.updateAccount.run({
        id,
        name: name ?? current.name,
        provider: provider ?? current.provider,
        env: env !== undefined ? (env ? JSON.stringify(env) : null) : (current.env ? JSON.stringify(current.env) : null),
      });
      return this.getAccount(id);
    },

    deleteAccount(id) {
      stmts.deleteAccount.run(id);
    },

    getAll() {
      return {
        projects: this.getProjects(),
        sessions: stmts.getAllSessions.all().map(rowToSession),
        accounts: this.getAccounts(),
      };
    },

    close() {
      db.close();
    },
  };
}
