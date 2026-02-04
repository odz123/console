# Home Screen & Projects Redesign

## Summary

Introduce a "project" concept that groups sessions by working directory. The sidebar shows projects with nested sessions. The home screen has a single "Add Project" button. A server-side directory browser modal lets users pick a folder path.

## Data Model

File: `projects.json` (replaces `sessions.json`, clean slate)

```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "opslane",
      "cwd": "/Users/abhishekray/Projects/opslane",
      "createdAt": "ISO-8601"
    }
  ],
  "sessions": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "name": "session-name",
      "claudeSessionId": null,
      "status": "running|exited",
      "createdAt": "ISO-8601"
    }
  ]
}
```

- A project = name + absolute directory path.
- Sessions are always tied to a project. No per-session cwd override; cwd is resolved from the parent project.
- `claudeSessionId` is captured from Claude CLI output (same regex as before).
- Duplicate project names are allowed. Duplicate `cwd` paths are allowed (different projects can point to the same directory).

### Migration Strategy

Clean slate. On first startup:
- If `sessions.json` exists, delete it (or ignore it).
- If `projects.json` does not exist, create it with `{ "projects": [], "sessions": [] }`.
- No migration of old sessions. The store code changes all references from `sessions.json` to `projects.json` and from `loadSessions/saveSessions` to `load/save` with the new shape.

## API Endpoints

### Projects

```
GET    /api/projects              → list all projects (includes nested sessions)
POST   /api/projects              → create project { name, cwd }
DELETE /api/projects/:id          → delete project + all its sessions + kill running PTYs
```

**POST /api/projects** validation:
- `name`: required string, 1-100 chars.
- `cwd`: required string, 1-1024 chars, must be an existing directory on disk (`fs.stat` check).
- Returns 201 with the created project object.
- Returns 400 with `{ error: "message" }` on validation failure.

**DELETE /api/projects/:id** behavior:
1. Kill all running PTY processes for sessions belonging to this project.
2. If any connected WebSocket client has an active session under this project, send `{ type: "session-deleted", sessionId }` so the client detaches and returns to home.
3. Remove all sessions belonging to this project from the store.
4. Remove the project from the store.
5. Broadcast updated state to all clients.
6. Returns `{ ok: true }`. Returns 404 if project not found.

### Sessions (scoped to projects)

```
POST   /api/projects/:id/sessions → create session { name }
DELETE /api/sessions/:id          → delete single session + kill PTY
POST   /api/sessions/:id/restart  → restart session
```

**POST /api/projects/:id/sessions**:
- `name`: required string, 1-100 chars.
- Looks up project by `:id`. Returns 404 if project not found.
- Validates project `cwd` still exists on disk. Returns 400 `{ error: "Project directory no longer exists" }` if not.
- Spawns Claude CLI in the project's `cwd`.
- Returns 201 with session object including `alive: true`.

**DELETE /api/sessions/:id**:
- Kills PTY process if running.
- Sends `{ type: "session-deleted", sessionId }` to attached clients.
- Removes session from store. Broadcasts updated state.
- Returns `{ ok: true }`. Returns 404 if not found.

**POST /api/sessions/:id/restart**:
- Looks up session, then looks up parent project.
- Validates project `cwd` exists on disk. Returns 400 if not.
- Kills existing PTY, respawns with `claudeSessionId` if available.
- Returns session object with `alive: true`.

**GET /api/projects/:id/sessions** — removed. Sessions are included in the `GET /api/projects` response and in WebSocket state broadcasts. No need for a separate endpoint.

### Directory Browser

```
GET    /api/browse?path=/some/dir → list subdirectories at path
```

Response:
```json
{
  "path": "/Users/abhishekray/Projects",
  "parent": "/Users/abhishekray",
  "dirs": ["opslane", "personal", "tools"]
}
```

- Defaults to `os.homedir()` when no `path` provided.
- Returns only directories (filters files), skips hidden dirs (`.` prefix).
- Sorts directories alphabetically, case-insensitive.
- `parent` is `null` when `path` is `/` (filesystem root).

**Security:**
- Resolve path with `fs.realpath()` to follow symlinks, then validate the resolved path is under `os.homedir()`. Reject with 403 if outside.
- Return generic 400 for non-existent paths. Do not leak path existence info outside homedir.
- Cap response to 500 entries. If a directory has more, return the first 500 sorted alphabetically.
- Server already binds to `127.0.0.1` only. Add a note in CLAUDE.md that `/api/browse` must never be exposed publicly.

**Client-side path joining:**
- The client constructs the next path by joining `response.path` + clicked `dir` name. The server always returns the resolved absolute `path` so the client can use it directly for the next request: `GET /api/browse?path=${encodeURIComponent(currentPath + '/' + dirName)}`.

## Frontend Layout

### Sidebar (~240px)

- Header: "Projects" label + "+" button (opens add-project modal).
- Project list: each project shows name with a collapsible arrow.
- Click arrow or project name → toggles expand/collapse to show sessions underneath.
- Collapsed/expanded state is ephemeral (in-memory only, resets on page reload).
- Projects sorted by `createdAt` ascending. Sessions sorted by `createdAt` ascending within each project.
- Each session: status dot (green=alive, gray=exited) + name + relative timestamp.
- Click session → attaches terminal in main area.
- Under each project's session list: "+ New Session" link.

**Relative timestamps:**
- Use a simple helper: "just now" (<1min), "Xm ago" (<1hr), "Xh ago" (<24hr), "Xd ago" (<30d), "Xmo ago".
- No periodic refresh; timestamps update when WebSocket state broadcasts arrive (which happen on every mutation).

### Main Area

- **No session selected (home):** Centered "Add Project" button. Clicking opens the add-project modal.
- **Session selected:** Full-screen xterm.js terminal (same as today).
- **Active session deleted by another client or project deletion:** Client receives `session-deleted` message, clears terminal, returns to home view.

### Add Project Modal

- Overlay with backdrop. Closes on Escape key or clicking backdrop.
- Two fields: project name (text input, autofocused) and directory path (text input, read-only, populated by browser).
- "Browse" button next to directory path field opens the directory browser panel below.
- Directory browser panel:
  - Breadcrumb bar at top showing current path segments. Each segment is clickable to jump back.
  - `~` is shown for the home directory in breadcrumbs.
  - Scrollable list of folders. Click a folder to navigate into it.
  - "Select This Directory" button confirms the current browsed path.
- "Cancel" and "Create Project" buttons at modal bottom.
- "Create Project" is disabled until both name and path are filled.
- On success: modal closes, project appears in sidebar, state broadcasts to all clients.

### New Session Flow

- Click "+ New Session" under a project in the sidebar.
- Inline input field appears (or small modal) for session name.
- Enter/confirm → POST to create session → terminal attaches immediately.
- If project directory no longer exists on disk, show error inline.

## WebSocket Protocol

### State Broadcast

Replace the current `type: "sessions"` message with:

```json
{
  "type": "state",
  "projects": [
    {
      "id": "uuid",
      "name": "opslane",
      "cwd": "/path",
      "createdAt": "ISO-8601"
    }
  ],
  "sessions": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "name": "session-name",
      "claudeSessionId": "uuid|null",
      "status": "running|exited",
      "alive": true,
      "createdAt": "ISO-8601"
    }
  ]
}
```

- `alive` is a computed boolean (true if PTY process is currently running). `status` is the persisted state.
- Broadcast on: client connect, project create/delete, session create/delete/restart/exit.

### Session Deleted

```json
{
  "type": "session-deleted",
  "sessionId": "uuid"
}
```

Sent to all clients when a session is removed (direct delete or project delete). Clients attached to that session should detach and return to home.

### Existing messages (unchanged)

- `{ type: "attach", sessionId, cols, rows }` — client → server
- `{ type: "input", data }` — client → server
- `{ type: "resize", cols, rows }` — client → server
- `{ type: "output", sessionId, data }` — server → client
- `{ type: "replay-done", sessionId }` — server → client
- `{ type: "exited", sessionId }` — server → client (PTY process exited, session still exists)

## Implementation Details

### Store Changes (`store.js`)

- File path: `projects.json` (was `sessions.json`).
- Exports: `load()` → returns `{ projects, sessions }`, `save(data)` → writes atomically.
- On load, if file missing, return `{ projects: [], sessions: [] }`.
- Delete `sessions.json` reference entirely from codebase.

### Directory Browser Endpoint

- `fs.readdir(path, { withFileTypes: true })` → filter `.isDirectory()`, skip names starting with `.`.
- `fs.realpath(path)` to resolve symlinks before validation.
- Validate resolved path starts with `os.homedir()`. Reject with 403 otherwise.
- Sort alphabetically case-insensitive. Cap at 500 entries.
- Compute `parent` as `path.dirname(resolvedPath)`, or `null` if at `/`.

### Session Spawn Changes (`server.js`)

- `createSession(projectId, name)`: look up project by id, use `project.cwd` as the spawn directory.
- `restartSession(sessionId)`: look up session → look up project → use `project.cwd`. Validate cwd exists.
- Startup resume: iterate sessions with `status === "running"` and `claudeSessionId`. For each, find parent project, validate `project.cwd` exists. If cwd missing, set `status = "exited"` and skip. Otherwise spawn with `claude --resume`.

### Frontend Changes (`public/app.js`, `public/index.html`, `public/style.css`)

- Replace flat session list rendering with project-grouped rendering.
- Add modal HTML/CSS for add-project and directory browser.
- Handle `type: "state"` WebSocket messages (replace `type: "sessions"` handler).
- Handle `type: "session-deleted"` to auto-detach.
- Add relative timestamp helper function.
- New session creation scoped to a project (inline input or small prompt).

### What Stays the Same

- `pty-manager.js` core logic (spawn, buffer, resize, kill) — no changes needed.
- xterm.js terminal rendering and fit addon.
- WebSocket attach/input/resize flow.
- Vendor directory (untouched).

## Testing

New tests to add:
- Store: load/save with new `projects.json` shape, handle missing file.
- API: create/delete projects, create/delete sessions scoped to projects, validation errors.
- API: `/api/browse` — default path, navigation, hidden dir filtering, symlink escape rejection, 403 outside homedir.
- WebSocket: `type: "state"` broadcast shape, `type: "session-deleted"` on project delete.
- Edge case: delete project with running sessions, restart session with missing cwd.
