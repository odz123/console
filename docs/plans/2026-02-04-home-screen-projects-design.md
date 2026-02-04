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

## API Endpoints

### Projects

```
GET    /api/projects              → list all projects
POST   /api/projects              → create project { name, cwd }
DELETE /api/projects/:id          → delete project + all its sessions
```

### Sessions (scoped to projects)

```
GET    /api/projects/:id/sessions → list sessions for a project
POST   /api/projects/:id/sessions → create session { name }
DELETE /api/sessions/:id          → delete single session
POST   /api/sessions/:id/restart  → restart session
```

### Directory Browser

```
GET    /api/browse?path=/some/dir → list subdirectories at path
```

Response:
```json
{
  "path": "/absolute/current",
  "parent": "/absolute/parent",
  "dirs": ["folder1", "folder2"]
}
```

- Defaults to `os.homedir()` when no path provided.
- Returns only directories, skips hidden dirs (`.` prefix) by default.
- Validates path exists and is a directory (400 otherwise).
- Prevents traversal outside filesystem root.

## Frontend Layout

### Sidebar (~240px)

- Header: "Projects" label + "+" button (opens add-project modal).
- Project list: each project shows name with a collapsible arrow.
- Click project → expands to show sessions underneath.
- Each session: status dot (green/gray) + name + relative timestamp ("2d ago").
- Click session → attaches terminal in main area.
- Under each project's session list: "+ New Session" link.

### Main Area

- **No session selected (home):** Centered "Add Project" button.
- **Session selected:** Full-screen xterm.js terminal.

### Add Project Modal

- Overlay modal with two fields: project name (text input) and directory path.
- Directory path field has a "Browse" button.
- Browse opens a directory browser panel inside the modal.
- Browser starts at `~`, shows folder list, click to navigate deeper.
- Breadcrumb path at top (e.g., `~ / Projects / opslane`).
- "Select" confirms the directory, Cancel and Create buttons at bottom.

### New Session Flow

- Click "+ New Session" under a project.
- Prompt for session name only (cwd from project).
- Creates and immediately attaches terminal.

## Implementation Details

### Directory Browser Endpoint

- `fs.readdir` with `withFileTypes` to filter directories only.
- Sanitize path input to prevent traversal attacks.
- Sort directories alphabetically.

### Store Changes

- `store.js` file path changes from `sessions.json` to `projects.json`.
- Data shape: `{ projects: [], sessions: [] }`.
- Same atomic write strategy (temp file + rename).

### Session Spawn Changes

- When creating a session, resolve cwd from parent project.
- Resume logic on startup: iterate sessions with `status=running` and `claudeSessionId`, resolve cwd from their project.

### WebSocket Changes

- Broadcast `projects` and `sessions` together on connect and on any mutation.
- Each session in broadcast includes `projectId`.

### What Stays the Same

- `pty-manager.js` core logic (spawn, buffer, resize, kill).
- xterm.js terminal rendering.
- WebSocket attach/input/resize flow.
- Vendor directory (untouched).
