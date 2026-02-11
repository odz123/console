// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
import { PtyManager } from './pty-manager.js';
import { createStore } from './store.js';
import {
  validateGitRepo,
  validateWorktreesDir,
  resolveWorktreePath,
  sanitizeBranchName,
  createWorktree,
  removeWorktree,
  worktreeExists,
  isWorktreeDirty,
  isWorktreesIgnored,
  WorktreeDirtyCheckError,
  cleanupOrphanedWorktrees,
} from './git-worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 1024;
const GIT_EXEC_TIMEOUT_MS = 15_000;
const GIT_EXEC_MAX_BUFFER = 1024 * 1024; // 1MB

const MAX_SESSIONS_PER_PROJECT = 20;
const MAX_TOTAL_SESSIONS = 50;
const MAX_WEBSOCKET_CLIENTS = 100;

function gitOpts(cwd, extra) {
  return { cwd, timeout: GIT_EXEC_TIMEOUT_MS, maxBuffer: GIT_EXEC_MAX_BUFFER, ...extra };
}

export function createServer({ testMode = false } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const manager = new PtyManager();

  // In test mode, use bash instead of claude; in-memory SQLite
  const store = testMode ? createStore(':memory:') : createStore();
  const clients = new Set();
  const startTime = Date.now();

  // --- Security Headers ---
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const reqHost = req.hostname || '127.0.0.1';
    const wsOrigins = `ws://${reqHost}:* wss://${reqHost}:*`;
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wsOrigins}; img-src 'self' data:; font-src 'self'`
    );
    next();
  });

  // --- Request ID + Logging ---
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-ID', requestId);

    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      console.log(JSON.stringify({
        level,
        request_id: requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration_ms: duration,
        timestamp: new Date().toISOString(),
      }));
    });
    next();
  });

  // --- Rate Limiting ---
  const rateLimitMap = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = testMode ? 10000 : 100;
  const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60_000;

  function rateLimit(req, res, next) {
    const key = req.ip || '127.0.0.1';
    const now = Date.now();
    let entry = rateLimitMap.get(key);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry = { windowStart: now, count: 0 };
      rateLimitMap.set(key, entry);
    }

    entry.count++;

    if (entry.count > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }

    next();
  }

  // Periodically clean up stale rate limit entries
  const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        rateLimitMap.delete(key);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL);
  rateLimitCleanupTimer.unref();

  // Apply rate limiting to mutation endpoints
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
      return rateLimit(req, res, next);
    }
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  // --- Request Timeout ---
  app.use((req, res, next) => {
    const timeout = req.path.includes('/git/') ? 30_000 : 15_000;
    req.setTimeout(timeout);
    res.setTimeout(timeout, () => {
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout' });
      }
    });
    next();
  });

  // --- Response Compression ---
  // Compress JSON API responses using Node's built-in zlib (no external deps)
  app.use((req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('gzip')) return next();

    // Only compress API responses (not static files - express.static handles those)
    if (!req.path.startsWith('/api') && req.path !== '/health') return next();

    // Override res.json to compress the output
    const _json = res.json.bind(res);
    res.json = function (body) {
      const jsonStr = JSON.stringify(body);
      // Skip compression for small payloads (< 1KB)
      if (jsonStr.length < 1024) return _json.call(this, body);

      zlib.gzip(Buffer.from(jsonStr), (err, compressed) => {
        // Response may already be sent (e.g. request timeout fired during gzip)
        if (res.headersSent) return;
        if (err) return _json.call(this, body);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        res.setHeader('Content-Type', 'application/json');
        res.end(compressed);
      });
    };
    next();
  });

  // --- Health Check ---
  app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
      memory: {
        rss_mb: Math.round(memUsage.rss / 1024 / 1024),
        heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
      },
      sessions: {
        total: store.getAll().sessions.length,
        alive: manager.getAll().length,
      },
      websocket_clients: clients.size,
    });
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: testMode ? 0 : '1h',
  }));

  // --- Session-scoped file browser (for file tree) ---

  const BROWSE_ENTRY_LIMIT = 200;

  app.get('/api/browse', async (req, res, next) => {
    const { sessionId } = req.query;
    if (!sessionId) return next(); // fall through to original /api/browse handler

    const session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Resolve worktree root
    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const relativePath = req.query.path || '';

    // Reject absolute paths
    if (path.isAbsolute(relativePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(relativePath || '.');
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const resolved = relativePath ? path.resolve(worktreeRoot, normalized) : worktreeRoot;

    // Symlink-safe validation
    let realResolved, realRoot;
    try {
      realResolved = await fs.promises.realpath(resolved);
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(realResolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const allDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const allFiles = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const totalEntries = allDirs.length + allFiles.length;
    const dirs = allDirs.slice(0, BROWSE_ENTRY_LIMIT);
    const remaining = BROWSE_ENTRY_LIMIT - dirs.length;
    const files = allFiles.slice(0, Math.max(remaining, 0));
    const hasMore = totalEntries > BROWSE_ENTRY_LIMIT;

    const result = { dirs, files };
    if (hasMore) result.hasMore = true;
    res.json(result);
  });

  // --- Directory Browser ---

  app.get('/api/browse', async (req, res) => {
    const homedir = os.homedir();
    const requestedPath = req.query.path || homedir;

    let resolved;
    try {
      resolved = await fs.promises.realpath(requestedPath);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Security: must be under homedir (use path.sep to prevent prefix bypass e.g. /Users/abh vs /Users/abh2)
    if (resolved !== homedir && !resolved.startsWith(homedir + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 500);

    const parent = resolved === '/' ? null : path.dirname(resolved);

    res.json({ path: resolved, parent, dirs });
  });

  // --- File Viewer ---

  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  app.get('/api/file', async (req, res) => {
    const { sessionId, path: filePath } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    // Reject absolute paths
    if (path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const project = store.getProject(session.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Resolve worktree root
    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const resolved = path.resolve(worktreeRoot, normalized);

    // Symlink-safe: realpath and verify still under worktree root
    let realResolved;
    try {
      realResolved = await fs.promises.realpath(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    let realRoot;
    try {
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Worktree root not found' });
    }

    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    // Stat the file
    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'File too large (max 1MB)' });
    }

    // Check if this is an image file we can serve directly
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
    const IMAGE_MIME = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      ico: 'image/x-icon', bmp: 'image/bmp',
    };
    const fileExt = path.extname(realResolved).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(fileExt)) {
      let imgContent;
      try {
        imgContent = await fs.promises.readFile(realResolved);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.type(IMAGE_MIME[fileExt] || 'application/octet-stream').send(imgContent);
    }

    // Read file and check for binary (null bytes in first 8KB)
    let content;
    try {
      content = await fs.promises.readFile(realResolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    const checkBytes = content.subarray(0, 8192);
    if (checkBytes.includes(0)) {
      return res.json({ isBinary: true });
    }

    res.type('text/plain').send(content.toString('utf-8'));
  });

  // --- File mtime (for auto-reload detection) ---

  app.get('/api/file/mtime', async (req, res) => {
    const { sessionId, path: filePath } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const resolved = path.resolve(worktreeRoot, normalized);

    let realResolved;
    try {
      realResolved = await fs.promises.realpath(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    let realRoot;
    try {
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Worktree root not found' });
    }

    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    try {
      const stat = await fs.promises.stat(realResolved);
      res.json({ mtime: stat.mtimeMs });
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
  });

  // --- File Write ---

  app.post('/api/file', express.json({ limit: '2mb' }), async (req, res) => {
    const { sessionId, path: filePath, content } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    // Reject absolute paths
    if (path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const project = store.getProject(session.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Resolve worktree root
    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const resolved = path.resolve(worktreeRoot, normalized);

    // Symlink-safe: realpath the parent dir and verify under worktree root
    const parentDir = path.dirname(resolved);
    let realParent;
    try {
      realParent = await fs.promises.realpath(parentDir);
    } catch {
      return res.status(404).json({ error: 'Parent directory not found' });
    }

    let realRoot;
    try {
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Worktree root not found' });
    }

    const finalPath = path.join(realParent, path.basename(resolved));
    if (!finalPath.startsWith(realRoot + path.sep) && finalPath !== realRoot) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    // Only overwrite existing files (don't create new ones)
    try {
      const stat = await fs.promises.stat(finalPath);
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Not a file' });
      }
    } catch {
      return res.status(404).json({ error: 'File not found — can only edit existing files' });
    }

    try {
      await fs.promises.writeFile(finalPath, content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to write file' });
    }
  });

  // --- Helper: resolve session worktree cwd ---

  async function resolveSessionCwd(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };

    const project = store.getProject(session.projectId);
    if (!project) return { error: 'Project not found', status: 404 };

    let cwd = project.cwd;
    if (session.worktreePath) {
      try {
        cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return { error: 'Invalid worktree path', status: 400 };
      }
    }

    return { cwd, session, project };
  }

  // --- Git API ---

  app.get('/api/sessions/:id/git/status', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;

    try {
      // Get current branch
      let branch = '';
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts(cwd));
        branch = stdout.trim();
      } catch {
        branch = 'HEAD (detached)';
      }

      // Get porcelain status
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-unormal'], gitOpts(cwd));

      const staged = [];
      const unstaged = [];
      const untracked = [];

      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const x = line[0]; // index (staged) status
        const y = line[1]; // worktree (unstaged) status
        const filePath = line.slice(3);

        if (x === '?' && y === '?') {
          untracked.push(filePath);
          continue;
        }

        // Staged changes (index column)
        if (x !== ' ' && x !== '?') {
          staged.push({ path: filePath, status: x });
        }

        // Unstaged changes (worktree column)
        if (y !== ' ' && y !== '?') {
          unstaged.push({ path: filePath, status: y });
        }
      }

      // Get ahead/behind info
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: abOut } = await execFileAsync(
          'git', ['rev-list', '--left-right', '--count', `@{upstream}...HEAD`],
          gitOpts(cwd)
        );
        const parts = abOut.trim().split(/\s+/);
        behind = parseInt(parts[0], 10) || 0;
        ahead = parseInt(parts[1], 10) || 0;
      } catch {
        // No upstream configured
      }

      res.json({ branch, staged, unstaged, untracked, ahead, behind });
    } catch (e) {
      res.status(500).json({ error: `Git status failed: ${e.message}` });
    }
  });

  app.get('/api/sessions/:id/git/diff', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const filePath = req.query.path;
    const isStaged = req.query.staged === 'true';

    // Validate path doesn't contain traversal (consistent with stage/discard)
    if (filePath) {
      if (typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path must be a string' });
      }
      const normalized = path.normalize(filePath);
      if (path.isAbsolute(filePath) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        return res.status(403).json({ error: 'Path traversal not allowed' });
      }
    }

    try {
      const args = ['diff', '--no-color'];
      if (isStaged) args.push('--cached');
      if (filePath) args.push('--', filePath);

      const { stdout } = await execFileAsync('git', args, gitOpts(cwd));
      res.json({ diff: stdout });
    } catch (e) {
      res.status(500).json({ error: `Git diff failed: ${e.message}` });
    }
  });

  app.post('/api/sessions/:id/git/stage', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const { paths, all } = req.body;

    if (!all && (!Array.isArray(paths) || paths.length === 0)) {
      return res.status(400).json({ error: 'paths array or all=true is required' });
    }

    // Validate paths don't contain traversal
    if (paths) {
      for (const p of paths) {
        if (typeof p !== 'string') {
          return res.status(400).json({ error: 'Each path must be a string' });
        }
        const normalized = path.normalize(p);
        if (path.isAbsolute(p) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
          return res.status(403).json({ error: 'Path traversal not allowed' });
        }
      }
    }

    try {
      const args = ['add'];
      if (all) {
        args.push('-A');
      } else {
        args.push('--', ...paths);
      }
      await execFileAsync('git', args, gitOpts(cwd));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Git stage failed: ${e.message}` });
    }
  });

  app.post('/api/sessions/:id/git/unstage', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const { paths, all } = req.body;

    if (!all && (!Array.isArray(paths) || paths.length === 0)) {
      return res.status(400).json({ error: 'paths array or all=true is required' });
    }

    // Validate paths
    if (paths) {
      for (const p of paths) {
        if (typeof p !== 'string') {
          return res.status(400).json({ error: 'Each path must be a string' });
        }
        const normalized = path.normalize(p);
        if (path.isAbsolute(p) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
          return res.status(403).json({ error: 'Path traversal not allowed' });
        }
      }
    }

    try {
      const args = ['reset', 'HEAD'];
      if (!all && paths) {
        args.push('--', ...paths);
      }
      await execFileAsync('git', args, gitOpts(cwd));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Git unstage failed: ${e.message}` });
    }
  });

  app.post('/api/sessions/:id/git/discard', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const { paths } = req.body;

    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    // Validate paths
    for (const p of paths) {
      if (typeof p !== 'string') {
        return res.status(400).json({ error: 'Each path must be a string' });
      }
      const normalized = path.normalize(p);
      if (path.isAbsolute(p) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        return res.status(403).json({ error: 'Path traversal not allowed' });
      }
    }

    try {
      await execFileAsync('git', ['checkout', '--', ...paths], gitOpts(cwd));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Git discard failed: ${e.message}` });
    }
  });

  app.post('/api/sessions/:id/git/commit', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Commit message is required' });
    }

    if (message.length > 5000) {
      return res.status(400).json({ error: 'Commit message too long (max 5000 chars)' });
    }

    try {
      // Check if there's anything staged
      const { stdout: statusOut } = await execFileAsync('git', ['diff', '--cached', '--name-only'], gitOpts(cwd));
      if (!statusOut.trim()) {
        return res.status(400).json({ error: 'Nothing staged to commit' });
      }

      await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', message], gitOpts(cwd));

      // Get the new commit info
      const { stdout: logOut } = await execFileAsync(
        'git', ['log', '-1', '--format=%H%n%h%n%s%n%an%n%aI'],
        gitOpts(cwd)
      );
      const [hash, shortHash, subject, author, date] = logOut.trim().split('\n');

      res.json({ ok: true, commit: { hash, shortHash, message: subject, author, date } });
    } catch (e) {
      res.status(500).json({ error: `Git commit failed: ${e.stderr || e.message}` });
    }
  });

  app.post('/api/sessions/:id/git/merge-to-main', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd, session, project } = result;

    if (!session.branchName) {
      return res.status(400).json({ error: 'Session has no branch', code: 'NO_BRANCH' });
    }

    const fullBranchName = `claude/${session.branchName}`;

    try {
      // Check worktree is clean
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], gitOpts(cwd));
      if (statusOut.trim()) {
        return res.status(400).json({
          error: 'Worktree has uncommitted changes. Commit or discard before merging.',
          code: 'DIRTY_WORKTREE',
        });
      }

      // Detect default branch from project root
      let defaultBranch;
      try {
        // Try symbolic-ref for the remote HEAD
        const { stdout: symRef } = await execFileAsync(
          'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
          gitOpts(project.cwd)
        );
        defaultBranch = symRef.trim().replace('refs/remotes/origin/', '');
      } catch {
        // Fall back: check for common branch names
        for (const candidate of ['main', 'master']) {
          try {
            await execFileAsync('git', ['rev-parse', '--verify', candidate], gitOpts(project.cwd));
            defaultBranch = candidate;
            break;
          } catch {
            // try next
          }
        }
      }

      if (!defaultBranch) {
        return res.status(400).json({
          error: 'Cannot determine default branch (main/master). Ensure one exists.',
          code: 'NO_DEFAULT_BRANCH',
        });
      }

      // Check for any uncommitted changes on the main worktree (project root)
      // Use -uno to ignore untracked files (e.g. .worktrees/ directory)
      const { stdout: mainStatus } = await execFileAsync('git', ['status', '--porcelain', '-uno'], gitOpts(project.cwd));
      if (mainStatus.trim()) {
        return res.status(400).json({
          error: `The ${defaultBranch} branch has uncommitted changes. Clean it before merging.`,
          code: 'MAIN_DIRTY',
        });
      }

      // Verify the project root is actually on the default branch
      const { stdout: currentBranch } = await execFileAsync(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
        gitOpts(project.cwd)
      );
      if (currentBranch.trim() !== defaultBranch) {
        return res.status(400).json({
          error: `Project root is on '${currentBranch.trim()}', expected '${defaultBranch}'. Cannot merge.`,
          code: 'WRONG_BRANCH',
        });
      }

      // Perform the merge from the project root
      try {
        await execFileAsync(
          'git', ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', fullBranchName],
          gitOpts(project.cwd)
        );
      } catch (mergeErr) {
        // Check if it's a merge conflict (git outputs conflict info to stdout)
        const mergeOutput = (mergeErr.stdout || '') + (mergeErr.stderr || '') + (mergeErr.message || '');
        if (mergeOutput.includes('CONFLICT') || mergeOutput.includes('Automatic merge failed') || mergeOutput.includes('Merge conflict')) {
          // Abort the failed merge to leave the project clean
          try {
            await execFileAsync('git', ['merge', '--abort'], gitOpts(project.cwd));
          } catch {
            // Best effort
          }
          return res.status(409).json({
            error: 'Merge conflict. Resolve conflicts manually or use the shell terminal.',
            code: 'MERGE_CONFLICT',
          });
        }
        throw mergeErr;
      }

      // Get the merge commit info
      const { stdout: logOut } = await execFileAsync(
        'git', ['log', '-1', '--format=%H%n%h%n%s%n%an%n%aI'],
        gitOpts(project.cwd)
      );
      const [hash, shortHash, subject, author, date] = logOut.trim().split('\n');

      res.json({
        ok: true,
        mergedBranch: fullBranchName,
        targetBranch: defaultBranch,
        commit: { hash, shortHash, message: subject, author, date },
      });
    } catch (e) {
      res.status(500).json({ error: `Merge failed: ${e.stderr || e.message}` });
    }
  });

  app.get('/api/sessions/:id/git/log', async (req, res) => {
    const result = await resolveSessionCwd(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { cwd } = result;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    try {
      const { stdout } = await execFileAsync(
        'git', ['log', `--max-count=${limit}`, '--format=%H%x00%h%x00%s%x00%an%x00%aI'],
        gitOpts(cwd)
      );

      const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, message, author, date] = line.split('\x00');
        return { hash, shortHash, message, author, date };
      });

      res.json({ commits });
    } catch (e) {
      res.status(500).json({ error: `Git log failed: ${e.message}` });
    }
  });

  // --- Helpers ---

  function safeSend(ws, msg) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected mid-send; ignore
      }
    }
  }

  function broadcastState() {
    const { projects, sessions } = store.getAll();
    const msg = JSON.stringify({
      type: 'state',
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
        idle: manager.isIdle(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }

  /** Derive the ~/.claude/projects/ directory for a given cwd. */
  function getClaudeProjectDir(cwd) {
    return path.join(
      os.homedir(), '.claude', 'projects',
      fs.realpathSync(cwd).replace(/\//g, '-').replace(/\./g, '-'),
    );
  }

  /** Codex CLI stores sessions under ~/.codex/sessions/. */
  function getCodexSessionDir() {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  async function spawnSession(session) {
    const project = store.getProject(session.projectId);
    if (!project) throw new Error('Project not found for session');

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

    // Capture the session ID by watching the CLI's session storage for new entries.
    // Claude: ~/.claude/projects/{normalized-cwd}/{sessionId}.jsonl
    // Codex:  ~/.codex/sessions/{sessionId} (directory per session)
    // Snapshot BEFORE spawn to avoid race where the CLI creates the file instantly.
    let existingJsonlFiles;
    let existingCodexSessions;

    if (!testMode && !session.claudeSessionId) {
      if (session.provider === 'codex') {
        const codexSessionDir = getCodexSessionDir();
        existingCodexSessions = new Set();
        try {
          existingCodexSessions = new Set(fs.readdirSync(codexSessionDir));
        } catch {
          // Directory may not exist yet — Codex will create it
        }
      } else {
        const claudeProjectDir = getClaudeProjectDir(cwd);
        existingJsonlFiles = new Set();
        try {
          existingJsonlFiles = new Set(
            fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl')),
          );
        } catch {
          // Directory may not exist yet — Claude will create it
        }
      }
    }

    const spawnOpts = {
      cwd,
      provider: session.provider || 'claude',
      providerOptions: session.providerOptions,
      ...(testMode
        ? { shell: '/bin/bash', args: ['-c', 'sleep 5'] }
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
      // Inject terminal cleanup: exit alternate screen + show cursor.
      // This ensures TUI apps (Codex, Claude) leave a clean terminal state
      // for both attached clients and future buffer replays.
      manager.injectToBuffer(session.id,
        '\x1b[?1049l'  // exit alternate screen (restore normal screen)
        + '\x1b[?25h'  // show cursor
      );
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    manager.onIdleChange(session.id, (idle) => {
      const msg = JSON.stringify({ type: 'session-idle', sessionId: session.id, idle });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    if (existingJsonlFiles) {
      const claudeProjectDir = getClaudeProjectDir(cwd);
      const MAX_POLL_MS = 60_000; // give up after 60s
      const startTime = Date.now();

      const pollInterval = setInterval(() => {
        if (Date.now() - startTime > MAX_POLL_MS) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const current = fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'));
          const newFile = current.find(f => !existingJsonlFiles.has(f));
          if (newFile) {
            const claudeSessionId = newFile.replace('.jsonl', '');
            store.updateSession(session.id, { claudeSessionId });
            broadcastState();
            clearInterval(pollInterval);
          }
        } catch {
          // Directory not yet created — keep polling
        }
      }, 500);

      // Stop polling when the process exits
      manager.onExit(session.id, () => clearInterval(pollInterval));
    }

    // Codex session ID tracking — scan ~/.codex/sessions/ for new entries
    if (existingCodexSessions) {
      const codexSessionDir = getCodexSessionDir();
      const MAX_POLL_MS = 60_000;
      const startTime = Date.now();

      const pollInterval = setInterval(() => {
        if (Date.now() - startTime > MAX_POLL_MS) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const current = fs.readdirSync(codexSessionDir);
          const newEntry = current.find(f => !existingCodexSessions.has(f));
          if (newEntry) {
            // Session ID is the directory/file name (strip extension if present)
            const codexSessionId = newEntry.replace(/\.[^.]+$/, '');
            store.updateSession(session.id, { claudeSessionId: codexSessionId });
            broadcastState();
            clearInterval(pollInterval);
          }
        } catch {
          // Directory not yet created — keep polling
        }
      }, 500);

      manager.onExit(session.id, () => clearInterval(pollInterval));
    }
  }

  // --- Projects REST API ---

  app.get('/api/projects', (req, res) => {
    const { projects, sessions } = store.getAll();
    res.json({
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
        idle: manager.isIdle(s.id),
      })),
    });
  });

  app.post('/api/projects', async (req, res) => {
    const { name, cwd } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }
    if (!cwd || typeof cwd !== 'string' || cwd.length > MAX_CWD_LENGTH) {
      return res.status(400).json({ error: `cwd is required (string, max ${MAX_CWD_LENGTH} chars)` });
    }

    const expanded = cwd.startsWith('~') ? cwd.replace(/^~/, os.homedir()) : cwd;
    const resolvedCwd = path.resolve(expanded);
    try {
      const stat = await fs.promises.stat(resolvedCwd);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'cwd does not exist' });
    }

    // Validate git repository
    const gitValidation = await validateGitRepo(resolvedCwd);
    if (!gitValidation.valid) {
      return res.status(400).json({
        error: gitValidation.message,
        code: gitValidation.code,
      });
    }

    const project = store.createProject({
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    });

    broadcastState();
    res.status(201).json(project);
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });

    const projectSessions = store.getSessions(req.params.id);
    for (const s of projectSessions) {
      manager.kill(s.id);
      manager.killShell(s.id);
      const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    }

    for (const s of projectSessions) {
      if (!s.branchName) continue;
      try {
        await removeWorktree(project.cwd, s.branchName, project.id, { deleteBranch: true });
      } catch {
        // Best-effort cleanup
      }
    }

    store.deleteProject(req.params.id);
    broadcastState();
    res.json({ ok: true });
  });

  // --- Sessions REST API ---

  const VALID_PROVIDERS = ['claude', 'codex'];

  const VALID_CODEX_APPROVAL_MODES = ['suggest', 'auto-edit', 'full-auto'];

  app.post('/api/projects/:id/sessions', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { name, provider = 'claude', providerOptions } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
    }

    // Validate providerOptions when provided
    if (providerOptions != null) {
      if (typeof providerOptions !== 'object' || Array.isArray(providerOptions)) {
        return res.status(400).json({ error: 'providerOptions must be an object' });
      }
      if (provider === 'codex') {
        if (providerOptions.approvalMode && !VALID_CODEX_APPROVAL_MODES.includes(providerOptions.approvalMode)) {
          return res.status(400).json({ error: `approvalMode must be one of: ${VALID_CODEX_APPROVAL_MODES.join(', ')}` });
        }
        if (providerOptions.model != null && (typeof providerOptions.model !== 'string' || providerOptions.model.length > 100)) {
          return res.status(400).json({ error: 'model must be a string (max 100 chars)' });
        }
      }
    }

    // Enforce resource limits
    const projectSessions = store.getSessions(req.params.id);
    if (projectSessions.length >= MAX_SESSIONS_PER_PROJECT) {
      return res.status(429).json({
        error: `Maximum sessions per project reached (${MAX_SESSIONS_PER_PROJECT}). Delete or archive existing sessions.`,
        code: 'SESSION_LIMIT_PER_PROJECT',
      });
    }
    const allSessions = store.getAll().sessions;
    if (allSessions.length >= MAX_TOTAL_SESSIONS) {
      return res.status(429).json({
        error: `Maximum total sessions reached (${MAX_TOTAL_SESSIONS}). Delete or archive existing sessions.`,
        code: 'SESSION_LIMIT_TOTAL',
      });
    }

    try {
      const stat = await fs.promises.stat(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    const sessionId = crypto.randomUUID();
    const branchName = `${sanitizeBranchName(name)}-${sessionId.slice(0, 7)}`;
    const worktreePath = `.worktrees/${branchName}`;

    try {
      await createWorktree(project.cwd, branchName, project.id);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        code: e.code || 'WORKTREE_FAILED',
      });
    }

    let worktreeWarning = null;
    try {
      const isIgnored = await isWorktreesIgnored(project.cwd);
      if (!isIgnored) {
        worktreeWarning = 'Warning: .worktrees/ is not in .gitignore. Add it to avoid committing worktree files.';
      }
    } catch {
      // Ignore check errors
    }

    // Only store provider-specific options for the relevant provider
    const sanitizedOptions = provider === 'codex' && providerOptions
      ? { approvalMode: providerOptions.approvalMode, model: providerOptions.model }
      : null;

    const session = store.createSession({
      id: sessionId,
      projectId: project.id,
      name,
      branchName,
      worktreePath,
      claudeSessionId: null,
      provider,
      providerOptions: sanitizedOptions,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    try {
      await spawnSession(session);
    } catch (e) {
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

  app.delete('/api/sessions/:id', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

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

    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore removal errors
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

  app.patch('/api/sessions/:id', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }

    store.renameSession(req.params.id, name.trim());
    broadcastState();
    res.json(store.getSession(req.params.id));
  });

  app.post('/api/sessions/:id/archive', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

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

    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors
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

  // --- Orphan Cleanup ---

  let cleanupTimer = null;
  let isCleanupRunning = false;

  app.post('/api/cleanup', async (req, res) => {
    if (isCleanupRunning) {
      return res.status(429).json({ error: 'Cleanup already in progress' });
    }
    isCleanupRunning = true;
    try {
      const result = await cleanupOrphanedWorktrees(store, {
        gracePeriodMs: testMode ? 0 : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `Cleanup failed: ${e.message}` });
    } finally {
      isCleanupRunning = false;
    }
  });

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(400).json({ error: 'Parent project not found' });

    try {
      const stat = await fs.promises.stat(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    if (session.branchName) {
      const exists = await worktreeExists(project.cwd, session.branchName);
      if (!exists) {
        return res.status(400).json({
          error: 'Worktree no longer exists. Session cannot be restarted.',
          code: 'WORKTREE_MISSING',
        });
      }
    }

    manager.kill(session.id);

    store.updateSession(session.id, { status: 'running' });
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

  // --- WebSocket ---

  // Ping/pong heartbeat to detect stale connections
  const WS_HEARTBEAT_INTERVAL_MS = 30_000;

  const heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  wss.on('connection', (ws) => {
    // Enforce WebSocket connection limit
    if (clients.size >= MAX_WEBSOCKET_CLIENTS) {
      ws.close(1013, 'Maximum connections reached');
      return;
    }

    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let attachedSessionId = null;

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
          idle: manager.isIdle(s.id),
        })),
      })
    );

    // Track the current data listener so we can remove it on detach
    let dataListener = null;
    let shellDataListener = null;
    let attachedShellSessionId = null;
    // Track pending SIGWINCH nudge timer so resize messages can cancel it
    let nudgeTimer = null;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Validate message structure
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      // Validate common fields when present
      if (msg.sessionId !== undefined && typeof msg.sessionId !== 'string') return;
      if (msg.cols !== undefined && (!Number.isInteger(msg.cols) || msg.cols < 1 || msg.cols > 500)) return;
      if (msg.rows !== undefined && (!Number.isInteger(msg.rows) || msg.rows < 1 || msg.rows > 200)) return;
      if (msg.data !== undefined && typeof msg.data !== 'string') return;

      try {
      switch (msg.type) {
        case 'attach': {
          const { sessionId, cols, rows } = msg;
          const proc = manager.getProcess(sessionId);
          if (!proc) break;

          // Detach from previous
          if (attachedSessionId && dataListener) {
            manager.offData(attachedSessionId, dataListener);
            dataListener = null;
          }

          attachedSessionId = sessionId;

          // Resize before replay
          if (cols && rows) {
            manager.resize(sessionId, cols, rows);
          }

          // Install the live listener FIRST to capture everything.
          // Buffer data until replay is done, then switch to direct forwarding.
          const pendingData = [];
          let replaying = true;

          dataListener = (d) => {
            if (replaying) {
              pendingData.push(d);
            } else {
              safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: d }));
            }
          };
          manager.onData(sessionId, dataListener);

          // Replay buffer in a single message to reduce write-queue churn
          const buffer = manager.getBuffer(sessionId);
          if (buffer.length > 0) {
            const combined = buffer.join('');
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: combined }));
          }

          // Flush any data that arrived during replay, then switch to live
          replaying = false;
          for (const d of pendingData) {
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: d }));
          }

          // Send replay-done AFTER all data (buffer + pending) is sent
          safeSend(ws, JSON.stringify({ type: 'replay-done', sessionId }));

          // Nudge the TUI CLI to re-render by triggering a SIGWINCH via
          // a tiny resize bounce. Both Ink (Claude) and Codex listen for
          // SIGWINCH and repaint, restoring correct cursor/visibility.
          // Track the restore timer so a client resize cancels it.
          // Suppress idle-change events during the nudge to prevent the TUI
          // redraw output from falsely triggering a working→idle cycle.
          if (cols && rows && manager.isAlive(sessionId)) {
            if (nudgeTimer) clearTimeout(nudgeTimer);
            manager.suppressIdleChange(sessionId, 2000);
            const nudgeCols = Math.max(cols - 1, 1);
            manager.resize(sessionId, nudgeCols, rows);
            nudgeTimer = setTimeout(() => {
              nudgeTimer = null;
              manager.resize(sessionId, cols, rows);
            }, 50);
          }
          break;
        }

        case 'input': {
          if (attachedSessionId && msg.data) {
            manager.write(attachedSessionId, msg.data);
          }
          break;
        }

        case 'resize': {
          if (attachedSessionId && msg.cols && msg.rows) {
            // Cancel any pending SIGWINCH nudge restore — the client is
            // sending authoritative dimensions that supersede the nudge.
            if (nudgeTimer) {
              clearTimeout(nudgeTimer);
              nudgeTimer = null;
            }
            manager.resize(attachedSessionId, msg.cols, msg.rows);
          }
          break;
        }

        case 'shell-attach': {
          const { sessionId, cols, rows } = msg;
          const session = store.getSession(sessionId);
          if (!session) break;

          const project = store.getProject(session.projectId);
          if (!project) break;

          // Resolve worktree path BEFORE detaching the old listener so that
          // on error the previous shell connection remains intact.
          if (!manager.isShellAlive(sessionId)) {
            let cwd = project.cwd;
            if (session.worktreePath) {
              try {
                cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
              } catch {
                break;
              }
            }

            // Detach previous shell listener (use dedicated tracking variable
            // since attachedSessionId may already point to the new session)
            if (attachedShellSessionId && shellDataListener) {
              manager.offShellData(attachedShellSessionId, shellDataListener);
              shellDataListener = null;
            }
            attachedShellSessionId = sessionId;

            manager.spawnShell(sessionId, { cwd, cols, rows });
          } else {
            // Detach previous shell listener
            if (attachedShellSessionId && shellDataListener) {
              manager.offShellData(attachedShellSessionId, shellDataListener);
              shellDataListener = null;
            }
            attachedShellSessionId = sessionId;

            if (cols && rows) {
              manager.resizeShell(sessionId, cols, rows);
            }
          }

          // Install live listener with replay buffering (same pattern as attach)
          const shellPending = [];
          let shellReplaying = true;

          shellDataListener = (d) => {
            if (shellReplaying) {
              shellPending.push(d);
            } else {
              safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: d }));
            }
          };
          manager.onShellData(sessionId, shellDataListener);

          // Replay buffer
          const shellBuffer = manager.getShellBuffer(sessionId);
          if (shellBuffer.length > 0) {
            const combined = shellBuffer.join('');
            safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: combined }));
          }

          // Flush pending and switch to live
          shellReplaying = false;
          for (const d of shellPending) {
            safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: d }));
          }

          safeSend(ws, JSON.stringify({ type: 'shell-replay-done', sessionId }));
          break;
        }

        case 'shell-input': {
          if (msg.sessionId && msg.data) {
            manager.writeShell(msg.sessionId, msg.data);
          }
          break;
        }

        case 'shell-resize': {
          if (msg.sessionId && msg.cols && msg.rows) {
            manager.resizeShell(msg.sessionId, msg.cols, msg.rows);
          }
          break;
        }
      }
      } catch (err) {
        console.error('[ws] Unhandled error in message handler:', err);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (nudgeTimer) {
        clearTimeout(nudgeTimer);
        nudgeTimer = null;
      }
      if (attachedSessionId && dataListener) {
        manager.offData(attachedSessionId, dataListener);
      }
      if (attachedShellSessionId && shellDataListener) {
        manager.offShellData(attachedShellSessionId, shellDataListener);
      }
    });
  });

  // --- Global Error Handler ---
  // Must be registered after all routes (Express identifies error handlers by 4 args)
  app.use((err, req, res, _next) => {
    console.error(JSON.stringify({
      level: 'error',
      type: 'unhandled_route_error',
      method: req.method,
      url: req.originalUrl,
      error: err.message,
      stack: testMode ? undefined : err.stack,
      timestamp: new Date().toISOString(),
    }));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Startup: recover missing Claude session IDs, then resume ---

  if (!testMode) {
    const sessions = store.getAll().sessions;

    // First pass: resolve session IDs for every resumable session.
    // Claude: scan JSONL files under ~/.claude/projects/{cwd}/
    // Codex: verify session exists under ~/.codex/sessions/
    for (const session of sessions) {
      if (session.status !== 'running' && session.status !== 'exited') continue;

      // --- Codex sessions: verify existing session ID or mark exited ---
      if (session.provider === 'codex') {
        if (session.claudeSessionId) {
          try {
            const codexSessionDir = getCodexSessionDir();
            const entries = fs.readdirSync(codexSessionDir);
            const exists = entries.some(e =>
              e === session.claudeSessionId || e.startsWith(session.claudeSessionId + '.')
            );
            if (exists) {
              if (session.status === 'exited') {
                store.updateSession(session.id, { status: 'running' });
                console.log(`[startup] Revived codex session: ${session.name}`);
              }
              continue;
            }
          } catch {
            // ~/.codex/sessions/ doesn't exist
          }
        }
        // No valid session ID — mark exited (can still be restarted fresh)
        if (session.status !== 'exited') {
          store.updateSession(session.id, { status: 'exited' });
        }
        continue;
      }

      // --- Claude sessions: resolve latest JSONL ---
      const project = store.getProject(session.projectId);
      if (!project) continue;

      try {
        let cwd = project.cwd;
        if (session.worktreePath) {
          // Apply the same safety checks as resolveWorktreePath (sync version)
          const normalized = path.normalize(session.worktreePath);
          if (path.isAbsolute(session.worktreePath)
            || normalized === '..' || normalized.startsWith(`..${path.sep}`)
            || (!normalized.startsWith(`.worktrees${path.sep}`) && normalized !== '.worktrees')) {
            console.warn(`[startup] Invalid worktree path for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          const resolved = fs.realpathSync(path.resolve(project.cwd, normalized));
          const resolvedProject = fs.realpathSync(project.cwd);
          if (!resolved.startsWith(resolvedProject + path.sep)) {
            console.warn(`[startup] Worktree path escapes project for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          cwd = resolved;
        }
        const claudeProjectDir = getClaudeProjectDir(cwd);
        // Find the most recently modified JSONL that contains an actual conversation.
        // Claude CLI creates stub files (only file-history-snapshot entries) on every
        // launch including failed --resume attempts. Skip those.
        const jsonlFiles = fs.readdirSync(claudeProjectDir)
          .filter(f => {
            if (!f.endsWith('.jsonl')) return false;
            // Check if file has conversation data (not just snapshots)
            const content = fs.readFileSync(path.join(claudeProjectDir, f), 'utf8');
            const lines = content.split('\n').filter(Boolean);
            return lines.some(line => {
              try {
                const t = JSON.parse(line).type;
                return t && t !== 'file-history-snapshot';
              } catch { return false; }
            });
          })
          .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(claudeProjectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime); // most recently modified conversation first

        if (jsonlFiles.length > 0) {
          // Prefer the session's stored ID if it still exists on disk (non-stub).
          // Falling back to the latest JSONL only when the stored ID is missing or
          // was never captured.  This prevents multiple sessions sharing the same
          // project CWD from all being reassigned to the single newest file.
          const storedExists = session.claudeSessionId &&
            jsonlFiles.some(f => f.name === session.claudeSessionId + '.jsonl');
          const resolvedId = storedExists
            ? session.claudeSessionId
            : jsonlFiles[0].name.replace('.jsonl', '');

          if (resolvedId !== session.claudeSessionId || session.status === 'exited') {
            store.updateSession(session.id, { claudeSessionId: resolvedId, status: 'running' });
            console.log(`[startup] Updated claude session ID for ${session.name}: ${resolvedId}${session.claudeSessionId ? ` (was ${session.claudeSessionId})` : ' (was null)'}${session.status === 'exited' ? ' (revived)' : ''}`);
          }
        } else {
          console.warn(`[startup] No JSONL files found for ${session.name}, marking exited`);
          store.updateSession(session.id, { status: 'exited' });
        }
      } catch (err) {
        console.warn(`[startup] Could not resolve session ID for ${session.name}: ${err.message}`);
        store.updateSession(session.id, { status: 'exited' });
      }
    }

    // Second pass: resume all sessions that have a session ID (both Claude and Codex).
    const updatedSessions = store.getAll().sessions;
    for (const session of updatedSessions) {
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
        spawnSession(session).then(() => {
          console.log(`Resumed session: ${session.name} (${session.provider})`);
          broadcastState();
        }).catch((e) => {
          console.error(`Failed to resume ${session.name}: ${e.message}`);
          store.updateSession(session.id, { status: 'exited' });
          broadcastState();
        });
      }
    }
  }

  // --- Periodic Orphan Cleanup ---

  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  async function runCleanup() {
    if (isCleanupRunning) {
      console.log('[cleanup] Skipping — previous cleanup still running');
      return;
    }
    isCleanupRunning = true;
    try {
      await cleanupOrphanedWorktrees(store);
    } catch (e) {
      console.error(`[cleanup] Cleanup failed: ${e.message}`);
    } finally {
      isCleanupRunning = false;
    }
  }

  if (!testMode) {
    // Run cleanup on startup (async, don't block server start)
    runCleanup();

    // Schedule periodic cleanup
    cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  server.destroy = () => {
    return new Promise((resolve) => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      clearInterval(rateLimitCleanupTimer);
      clearInterval(heartbeatTimer);
      rateLimitMap.clear();
      manager.destroyAll();
      manager.destroyAllShells();
      // Mark all running sessions as exited before closing the DB.
      // manager.destroyAll() kills PTYs and removes listeners synchronously,
      // so the normal onExit handler never fires — do it explicitly here.
      const { sessions: allSessions } = store.getAll();
      for (const s of allSessions) {
        if (s.status === 'running') {
          store.updateSession(s.id, { status: 'exited' });
        }
      }
      store.close();
      wss.close();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      server.closeAllConnections();
      server.close(resolve);
    });
  };

  // Return server (not app) so WebSocket upgrade works
  return server;
}

// Run if executed directly (ESM-safe check)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}. Must be 1-65535.`);
    process.exit(1);
  }

  const host = process.env.HOST || '127.0.0.1';

  const server = createServer();

  // --- Process-level Error Handlers ---
  process.on('uncaughtException', (err) => {
    console.error(JSON.stringify({
      level: 'fatal',
      type: 'uncaught_exception',
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    }));
    server.destroy().then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({
      level: 'error',
      type: 'unhandled_rejection',
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: new Date().toISOString(),
    }));
  });

  // --- Graceful Shutdown ---
  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received, starting graceful shutdown...`);
    try {
      await server.destroy();
      console.log('Graceful shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error(`Error during shutdown: ${err.message}`);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(port, host, () => {
    const boundAddress = server.address().address;
    const isLocalhost = boundAddress === '127.0.0.1' || boundAddress === '::1';
    if (!isLocalhost) {
      console.warn('');
      console.warn('⚠  WARNING: Server is bound to a non-loopback address.');
      console.warn('   /api/browse and /api/file expose filesystem contents.');
      console.warn('   Only use this on trusted local networks.');
      console.warn('');
    }
    console.log(`Claude Console running at http://${boundAddress}:${port}`);
  });
}
