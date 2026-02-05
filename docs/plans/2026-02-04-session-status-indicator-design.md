# Session Status Indicator Design

**Date:** 2026-02-04
**Status:** Approved (v2 - post review)

## Overview

Add visual distinction between "Claude is running" (pulsing green) and "Claude is waiting for input" (solid green) in the sidebar session list.

## Current State

- Binary status: `alive` (green) vs `exited` (gray)
- No indication of whether Claude is actively generating or waiting

## New State Model

```
alive + active  → pulsing green (Claude is generating output)
alive + idle    → solid green (Claude is waiting for input)
exited          → gray (process terminated)
```

## Approach: Hybrid Idle Detection with Hysteresis

Use PTY output idle detection with:
- **1.5s idle threshold** - Prevents flicker during token streaming gaps
- **Immediate active on output** - Responsive feel when Claude starts generating
- **setTimeout instead of setInterval** - Avoids constant polling, resets on each output

## Implementation

### 1. PtyManager Changes (`pty-manager.js`)

Add idle tracking to `PtyProcess` class using setTimeout with hysteresis:

```javascript
class PtyProcess extends EventEmitter {
  constructor(ptyProcess) {
    // ... existing code
    this.idle = false;
    this.idleTimer = null;

    this._scheduleIdleCheck();
  }

  _scheduleIdleCheck() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.idle && this.alive) {
        this.idle = true;
        this.emit('idle-change', true);
      }
    }, 1500); // 1.5s threshold
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _onPtyData = (data) => {
    // Immediate switch to active on any output
    if (this.idle) {
      this.idle = false;
      this.emit('idle-change', false);
    }
    // Reset idle timer
    this._scheduleIdleCheck();
    // ... existing buffer/emit logic
  };

  _onPtyExit = ({ exitCode }) => {
    this._clearIdleTimer(); // Prevent timer leak
    this.alive = false;
    this.emit('exit', exitCode);
  };

  _cleanup() {
    this._clearIdleTimer();
    // ... existing cleanup
  }
}
```

Add new methods to `PtyManager`:

```javascript
isIdle(sessionId) {
  const proc = this.processes.get(sessionId);
  return proc ? proc.idle : true;
}

onIdleChange(sessionId, callback) {
  const proc = this.processes.get(sessionId);
  if (proc) proc.on('idle-change', callback);
}
```

### 2. Server Changes (`server.js`)

Broadcast idle state changes:

```javascript
// In spawnSession()
manager.onIdleChange(session.id, (idle) => {
  const msg = JSON.stringify({ type: 'session-idle', sessionId: session.id, idle });
  for (const ws of clients) {
    safeSend(ws, msg);
  }
});
```

Include idle in state broadcasts:

```javascript
sessions: data.sessions.map((s) => ({
  ...s,
  alive: manager.isAlive(s.id),
  idle: manager.isIdle(s.id),
})),
```

### 3. CSS Changes (`public/style.css`)

```css
.status-dot.alive.active {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(1.2);
  }
}
```

### 4. Frontend Changes (`public/app.js`)

Track idle state in memory map (survives re-renders):

```javascript
const sessionIdleState = new Map();

// WebSocket handler
case 'session-idle': {
  const { sessionId, idle } = msg;
  sessionIdleState.set(sessionId, idle);
  updateStatusDot(sessionId, idle);
  break;
}

// Targeted DOM update without full re-render
function updateStatusDot(sessionId, idle) {
  const dot = document.querySelector(`[data-session-id="${sessionId}"] .status-dot`);
  if (dot) {
    dot.classList.toggle('active', !idle);
  }
}
```

Update `renderSidebar()` to:
1. Add `data-session-id` attribute for targeting
2. Prefer local `sessionIdleState` over server state (fresher)

```javascript
// In session list item creation
li.dataset.sessionId = s.id;

// Status dot logic
const dot = document.createElement('span');
dot.className = 'status-dot';
if (s.alive) {
  dot.classList.add('alive');
  // Prefer local state, fall back to server state
  const idle = sessionIdleState.has(s.id) ? sessionIdleState.get(s.id) : s.idle;
  if (!idle) dot.classList.add('active');
} else {
  dot.classList.add('exited');
  sessionIdleState.delete(s.id); // Clean up on exit
}
```

Sync state on full state updates:

```javascript
case 'state': {
  // ... existing code
  // Sync idle state from server for any sessions we don't have local state for
  for (const s of sessions) {
    if (!sessionIdleState.has(s.id) && s.idle !== undefined) {
      sessionIdleState.set(s.id, s.idle);
    }
  }
  renderSidebar();
  break;
}
```

## Edge Cases

1. **New session spawn** - Starts as `active` (pulsing), timer begins
2. **Session restart** - Clears old timer, starts fresh as `active`
3. **Process exit** - Timer cleared in `_onPtyExit`, dot goes gray, local state cleaned up
4. **Client reconnect** - Gets current idle state via `broadcastState()`, synced to local map
5. **Startup silence** - Will show active for 1.5s, then idle (acceptable)

## Known Limitations

- **Echo triggers active** - User keystrokes echo as output, briefly showing "active" while typing. This is acceptable as it provides feedback that input is being received.
- **Output-based detection** - Cannot distinguish Claude thinking vs external shell output. JSONL watching could address this in v2.

## Future Enhancement

JSONL file watching for ground-truth state detection:
- Watch `~/.claude/projects/<project-path>/<claudeSessionId>.jsonl`
- Look for `type: "system"` with `subtype: "stop_hook_summary"` or `"turn_duration"`
- Would provide accurate "Claude finished turn" signal
- Not needed for v1

## Files to Modify

1. `pty-manager.js` - Add idle tracking with setTimeout
2. `server.js` - Broadcast idle changes, include in state
3. `public/style.css` - Add pulse animation
4. `public/app.js` - Handle idle messages, update dots, add data-session-id

## Review Feedback Incorporated

- [x] Use setTimeout instead of setInterval (avoids constant polling)
- [x] Clear timer in _onPtyExit (prevents timer leaks)
- [x] Add data-session-id attribute (fixes selector targeting)
- [x] Increase threshold to 1.5s (reduces flicker)
- [x] Hysteresis pattern (immediate active, delayed idle)
- [x] Persist idle state in sessionIdleState map (survives re-renders)
- [x] Clean up state on session exit
