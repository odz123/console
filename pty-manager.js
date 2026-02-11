// pty-manager.js
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 1024 * 1024; // 1MB

class PtyProcess extends EventEmitter {
  constructor(ptyProcess) {
    super();
    this.pty = ptyProcess;
    this.buffer = [];
    this.bufferSize = 0;
    this.alive = true;
    this.idle = false;
    this.idleTimer = null;
    this._idleSuppressedUntil = 0;

    this._scheduleIdleCheck();

    this._onPtyData = (data) => {
      // During idle suppression (e.g. SIGWINCH nudge), buffer data and emit
      // to listeners but don't toggle the idle state — the TUI redraw output
      // is cosmetic and doesn't indicate real activity.
      const suppressed = Date.now() < this._idleSuppressedUntil;
      if (!suppressed) {
        if (this.idle) {
          this.idle = false;
          this.emit('idle-change', false);
        }
        this._scheduleIdleCheck();
      }
      this._pushToBuffer(data);
      this.emit('data', data);
    };

    this._onPtyExit = ({ exitCode }) => {
      this._clearIdleTimer();
      this.alive = false;
      this.emit('exit', exitCode);
      // Remove all listeners after exit handlers have run to prevent
      // memory leaks from captured closures (WebSocket refs, etc.).
      // Buffer is preserved for replay; only listeners are cleaned up.
      this.removeAllListeners();
    };

    this.pty.onData(this._onPtyData);
    this.pty.onExit(this._onPtyExit);
  }

  _scheduleIdleCheck() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.idle && this.alive) {
        this.idle = true;
        this.emit('idle-change', true);
      }
    }, 1500);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _pushToBuffer(data) {
    this.buffer.push(data);
    this.bufferSize += data.length;
    while (this.bufferSize > MAX_BUFFER) {
      const removed = this.buffer.shift();
      this.bufferSize -= removed.length;
    }
  }

  /**
   * Inject data into the buffer and emit to listeners without writing to PTY.
   * Used to append terminal cleanup sequences after process exit.
   */
  injectData(data) {
    this._pushToBuffer(data);
    this.emit('data', data);
  }

  write(data) {
    if (this.alive) {
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    if (this.alive) {
      this.pty.resize(cols, rows);
    }
  }

  /**
   * Temporarily suppress idle-change events for the given duration (ms).
   * Used during SIGWINCH resize nudge to prevent TUI redraw output from
   * falsely triggering a working → idle cycle.
   */
  suppressIdleChange(durationMs) {
    this._idleSuppressedUntil = Date.now() + durationMs;
  }

  kill() {
    if (this.alive) {
      this.pty.kill();
      this.alive = false;
    }
    this._cleanup();
  }

  _cleanup() {
    this._clearIdleTimer();
    this.buffer.length = 0;
    this.bufferSize = 0;
    this.removeAllListeners();
  }
}

export class PtyManager {
  constructor() {
    this.processes = new Map();
    this.shellProcesses = new Map();
  }

  spawn(sessionId, { cwd, resumeId, cols = 80, rows = 24, shell, args, provider = 'claude', providerOptions, accountEnv }) {
    if (this.processes.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    let command, cmdArgs;
    if (shell) {
      command = shell;
      cmdArgs = args || [];
    } else if (provider === 'codex') {
      command = 'codex';
      if (resumeId) {
        // `codex resume <SESSION_ID>` continues a previous session
        cmdArgs = ['resume', resumeId];
      } else {
        cmdArgs = [];
        // Approval mode: --full-auto or --ask-for-approval <mode>
        if (providerOptions?.approvalMode === 'full-auto') {
          cmdArgs.push('--full-auto');
        } else if (providerOptions?.approvalMode && providerOptions.approvalMode !== 'suggest') {
          cmdArgs.push('--ask-for-approval', providerOptions.approvalMode);
        }
      }
      // --model applies to both new and resumed sessions
      if (providerOptions?.model) {
        cmdArgs.push('--model', providerOptions.model);
      }
    } else if (resumeId) {
      command = 'claude';
      cmdArgs = ['--resume', resumeId];
    } else {
      command = 'claude';
      cmdArgs = [];
    }

    const ptyProcess = pty.spawn(command, cmdArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...accountEnv, TERM: 'xterm-256color' },
    });

    const proc = new PtyProcess(ptyProcess);
    this.processes.set(sessionId, proc);
    return proc;
  }

  getProcess(sessionId) {
    return this.processes.get(sessionId) || null;
  }

  getBuffer(sessionId) {
    const proc = this.processes.get(sessionId);
    return proc ? proc.buffer : [];
  }

  /**
   * Inject data into a session's buffer and emit to listeners.
   * Does not write to the PTY — used for post-exit cleanup sequences.
   */
  injectToBuffer(sessionId, data) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.injectData(data);
  }

  write(sessionId, data) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.write(data);
  }

  resize(sessionId, cols, rows) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.resize(cols, rows);
  }

  kill(sessionId) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill();
      this.processes.delete(sessionId);
    }
  }

  onExit(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      // If already dead, fire immediately
      if (!proc.alive) {
        callback();
      } else {
        proc.on('exit', callback);
      }
    }
  }

  onData(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.on('data', callback);
  }

  offData(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.off('data', callback);
  }

  getAll() {
    return [...this.processes.keys()];
  }

  isAlive(sessionId) {
    const proc = this.processes.get(sessionId);
    return proc ? proc.alive : false;
  }

  isIdle(sessionId) {
    const proc = this.processes.get(sessionId);
    return proc ? proc.idle : true;
  }

  onIdleChange(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.on('idle-change', callback);
  }

  offIdleChange(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.off('idle-change', callback);
  }

  suppressIdleChange(sessionId, durationMs) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.suppressIdleChange(durationMs);
  }

  destroyAll() {
    for (const id of this.getAll()) {
      this.kill(id);
    }
  }

  spawnShell(sessionId, { cwd, cols = 80, rows = 24 }) {
    if (this.shellProcesses.has(sessionId)) {
      throw new Error(`Shell for session ${sessionId} already exists`);
    }

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const proc = new PtyProcess(ptyProcess);
    this.shellProcesses.set(sessionId, proc);
    return proc;
  }

  getShellProcess(sessionId) {
    return this.shellProcesses.get(sessionId) || null;
  }

  getShellBuffer(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    return proc ? proc.buffer : [];
  }

  writeShell(sessionId, data) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.write(data);
  }

  resizeShell(sessionId, cols, rows) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.resize(cols, rows);
  }

  killShell(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.shellProcesses.delete(sessionId);
    }
  }

  isShellAlive(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    return proc ? proc.alive : false;
  }

  onShellData(sessionId, callback) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.on('data', callback);
  }

  offShellData(sessionId, callback) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.off('data', callback);
  }

  destroyAllShells() {
    for (const [id] of this.shellProcesses) {
      this.killShell(id);
    }
  }
}
