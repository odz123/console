// app.js
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let activeSessionId = null;
  let projects = [];
  let sessions = [];
  let expandedProjects = new Set();
  const sessionIdleState = new Map();
  let reconnectDelay = 1000;
  let toastTimeout = null;
  let shellTerm = null;
  let shellFitAddon = null;
  let expandedDirs = new Set(); // tracks expanded directory paths in file tree
  let openTabs = []; // { id, filename, fullPath, content, type }
  let activeTabId = 'claude';

  // --- Sticky scroll state ---
  const NEAR_BOTTOM_LINES = 2;
  let claudeSticky = true;
  let claudePendingScroll = false;
  let shellSticky = true;
  let shellPendingScroll = false;

  // Attach auto-scroll: force scroll-to-bottom on every write during session
  // attach until output settles. Covers replay buffer + SIGWINCH re-render.
  let claudeAttachScroll = false;
  let claudeAttachTimer = null;
  let shellAttachScroll = false;
  let shellAttachTimer = null;
  const ATTACH_SETTLE_MS = 300;

  function isNearBottom(t) {
    const buf = t.buffer.active;
    // Alternate screen (e.g. vim, less) has no scrollback; always "at bottom"
    if (buf.type === 'alternate') return true;
    return (buf.baseY - buf.viewportY) <= NEAR_BOTTOM_LINES;
  }

  // --- DOM refs ---
  const projectListEl = document.getElementById('project-list');
  const terminalEl = document.getElementById('terminal');
  const noSession = document.getElementById('no-session');
  const btnAddProject = document.getElementById('btn-add-project');
  const btnHomeAddProject = document.getElementById('btn-home-add-project');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalProjectName = document.getElementById('modal-project-name');
  const modalProjectPath = document.getElementById('modal-project-path');
  const btnBrowse = document.getElementById('btn-browse');
  const dirBrowser = document.getElementById('dir-browser');
  const dirBreadcrumbs = document.getElementById('dir-breadcrumbs');
  const dirList = document.getElementById('dir-list');
  const btnSelectDir = document.getElementById('btn-select-dir');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalCreate = document.getElementById('btn-modal-create');
  const rightPanel = document.getElementById('right-panel');
  const shellTerminalEl = document.getElementById('shell-terminal');
  const rightPanelPath = document.getElementById('right-panel-path');
  const fileTreeEl = document.getElementById('file-tree');
  const tabBar = document.getElementById('tab-bar');
  const tabList = document.getElementById('tab-list');
  const fileViewer = document.getElementById('file-viewer');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const fileViewerRefresh = document.getElementById('file-viewer-refresh');
  const fileViewerWrap = document.getElementById('file-viewer-wrap');
  const fileViewerCopy = document.getElementById('file-viewer-copy');
  const fileViewerEdit = document.getElementById('file-viewer-edit');
  const fileViewerSave = document.getElementById('file-viewer-save');
  const fileViewerCancelEdit = document.getElementById('file-viewer-cancel-edit');
  const fileViewerContent = document.getElementById('file-viewer-content');
  let fileViewerWordWrap = false;
  let fileViewerEditing = false;

  // File viewer search refs
  const fvSearchBar = document.getElementById('fv-search-bar');
  const fvSearchInput = document.getElementById('fv-search-input');
  const fvSearchCount = document.getElementById('fv-search-count');
  const fvSearchPrev = document.getElementById('fv-search-prev');
  const fvSearchNext = document.getElementById('fv-search-next');
  const fvSearchClose = document.getElementById('fv-search-close');
  let fvSearchMatches = [];
  let fvSearchCurrentIdx = -1;
  const btnToggleFileTree = document.getElementById('btn-toggle-file-tree');
  const btnRefreshFileTree = document.getElementById('btn-refresh-file-tree');
  const fileTreeSection = document.getElementById('file-tree-section');

  // Git panel refs
  const gitPanel = document.getElementById('git-panel');
  const gitBranchName = document.getElementById('git-branch-name');
  const gitAheadBehind = document.getElementById('git-ahead-behind');
  const btnGitRefresh = document.getElementById('btn-git-refresh');
  const btnGitMerge = document.getElementById('btn-git-merge');
  const gitCommitMessage = document.getElementById('git-commit-message');
  const btnGitCommit = document.getElementById('btn-git-commit');
  const gitFileList = document.getElementById('git-file-list');
  const gitLogList = document.getElementById('git-log-list');
  const btnGitLogToggle = document.getElementById('btn-git-log-toggle');
  const rightPanelTabs = document.getElementById('right-panel-tabs');
  let activeRightPanelTab = 'files';
  let gitLogExpanded = false;

  // Status bar refs
  const statusBar = document.getElementById('status-bar');
  const statusProvider = document.getElementById('status-provider');
  const statusBranch = document.getElementById('status-branch');
  const statusDuration = document.getElementById('status-duration');
  const statusActivity = document.getElementById('status-activity');
  const landingRecent = document.getElementById('landing-recent');
  let statusDurationTimer = null;

  // Breadcrumb bar refs
  const breadcrumbBar = document.getElementById('breadcrumb-bar');
  const breadcrumbProject = document.getElementById('breadcrumb-project');
  const breadcrumbSession = document.getElementById('breadcrumb-session');

  // Session control refs
  const statusInterrupt = document.getElementById('status-interrupt');
  const statusCompact = document.getElementById('status-compact');

  // File tree filter ref
  const fileTreeFilter = document.getElementById('file-tree-filter');

  // Keyboard shortcuts ref
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');

  // Command palette refs
  const cpOverlay = document.getElementById('command-palette-overlay');
  const cpInput = document.getElementById('cp-input');
  const cpResults = document.getElementById('cp-results');
  let cpSelectedIndex = -1;

  // Scroll-to-bottom ref
  const scrollToBottomBtn = document.getElementById('scroll-to-bottom');

  // Live sidebar timer
  let sidebarTimeTimer = null;

  // Connection/restart/CLI refs
  const statusConnection = document.getElementById('status-connection');
  const statusRestart = document.getElementById('status-restart');
  const statusCopyCli = document.getElementById('status-copy-cli');

  // Notification dot state
  let gitChangesPending = false;

  // Focus mode state
  let focusModeActive = false;

  // Sidebar filter ref
  const sidebarFilter = document.getElementById('sidebar-filter');

  // Git status cache for file tree change indicators
  let gitFileStatusMap = new Map(); // filePath -> status letter (M, A, D, ?, etc.)

  // Terminal font size zoom
  const statusFontSize = document.getElementById('status-font-size');
  const statusChanges = document.getElementById('status-changes');
  const DEFAULT_FONT_SIZE = 13;
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 24;
  let termFontSize = DEFAULT_FONT_SIZE;

  // --- Helpers ---
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function relativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  // --- File type icons ---
  const FILE_ICONS = {
    js: ['JS', 'file-icon-js'], mjs: ['JS', 'file-icon-js'], cjs: ['JS', 'file-icon-js'],
    ts: ['TS', 'file-icon-ts'], tsx: ['TS', 'file-icon-ts'], jsx: ['JS', 'file-icon-js'],
    py: ['Py', 'file-icon-py'],
    json: ['{}', 'file-icon-json'], jsonc: ['{}', 'file-icon-json'],
    md: ['M', 'file-icon-md'], markdown: ['M', 'file-icon-md'],
    css: ['#', 'file-icon-css'], scss: ['#', 'file-icon-css'], less: ['#', 'file-icon-css'],
    html: ['<>', 'file-icon-html'], htm: ['<>', 'file-icon-html'],
    svg: ['Sv', 'file-icon-img'], png: ['Im', 'file-icon-img'], jpg: ['Im', 'file-icon-img'],
    jpeg: ['Im', 'file-icon-img'], gif: ['Im', 'file-icon-img'], webp: ['Im', 'file-icon-img'],
    sh: ['$', 'file-icon-sh'], bash: ['$', 'file-icon-sh'], zsh: ['$', 'file-icon-sh'],
    yml: ['Y', 'file-icon-yml'], yaml: ['Y', 'file-icon-yml'], toml: ['T', 'file-icon-yml'],
    lock: ['Lk', 'file-icon-lock'],
    go: ['Go', 'file-icon-ts'], rs: ['Rs', 'file-icon-ts'], rb: ['Rb', 'file-icon-py'],
    java: ['Jv', 'file-icon-ts'], c: ['C', 'file-icon-ts'], h: ['H', 'file-icon-ts'],
    cpp: ['C+', 'file-icon-ts'], vue: ['V', 'file-icon-js'], svelte: ['Sv', 'file-icon-js'],
  };

  function getFileIcon(filename) {
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    return FILE_ICONS[ext] || ['\u00b7', 'file-icon-default'];
  }

  function createFileIcon(filename, extraClass) {
    const [text, cls] = getFileIcon(filename);
    const icon = document.createElement('span');
    icon.className = `${extraClass || 'file-icon'} ${cls}`;
    icon.textContent = text;
    return icon;
  }

  // --- Status bar ---
  function formatDuration(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  }

  function updateStatusBar() {
    if (!activeSessionId) {
      statusBar.classList.add('hidden');
      clearInterval(statusDurationTimer);
      statusDurationTimer = null;
      return;
    }
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) {
      statusBar.classList.add('hidden');
      return;
    }
    statusBar.classList.remove('hidden');

    // Provider
    const provName = session.provider === 'codex' ? 'Codex' : 'Claude';
    statusProvider.textContent = provName;

    // Branch
    statusBranch.textContent = session.branchName || 'no branch';

    // Duration
    statusDuration.textContent = formatDuration(session.createdAt);

    // Activity
    const idle = sessionIdleState.get(activeSessionId);
    const alive = session.alive !== false;
    let dotClass, label;
    if (!alive) {
      dotClass = 'exited';
      label = 'Exited';
    } else if (idle === false) {
      dotClass = 'working';
      label = 'Working...';
    } else {
      dotClass = 'idle';
      label = 'Idle';
    }
    statusActivity.innerHTML =
      `<span class="status-activity-dot ${dotClass}"></span> ${label}`;

    // Show/hide restart button based on session state
    if (!alive) {
      statusRestart.classList.remove('hidden');
      statusInterrupt.style.display = 'none';
      statusCompact.style.display = 'none';
    } else {
      statusRestart.classList.add('hidden');
      statusInterrupt.style.display = '';
      statusCompact.style.display = '';
    }

    // Adjust terminal wrapper inset for status bar + breadcrumb
    const termWrapper = document.getElementById('terminal-wrapper');
    if (termWrapper && termWrapper.style.display !== 'none') {
      termWrapper.style.inset = `${getTopInset()} 0 24px 0`;
    }

    // Start duration timer if not running
    if (!statusDurationTimer) {
      statusDurationTimer = setInterval(() => {
        const s = sessions.find(s2 => s2.id === activeSessionId);
        if (s) statusDuration.textContent = formatDuration(s.createdAt);
      }, 1000);
    }
  }

  // --- Landing page ---
  function renderLandingRecent() {
    if (!landingRecent) return;
    // Show up to 5 most recent sessions across all projects
    const recentSessions = [...sessions]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    if (recentSessions.length === 0) {
      landingRecent.innerHTML = '';
      return;
    }

    const header = document.createElement('div');
    header.className = 'landing-recent-header';
    header.textContent = 'Recent Sessions';

    const list = document.createElement('ul');
    list.className = 'landing-recent-list';

    for (const s of recentSessions) {
      const li = document.createElement('li');
      li.className = 'landing-recent-item';

      const dot = document.createElement('span');
      dot.className = `landing-recent-dot ${s.alive ? 'alive' : 'exited'}`;

      const name = document.createElement('span');
      name.className = 'landing-recent-name';
      const project = projects.find(p => p.id === s.projectId);
      name.textContent = (project ? project.name + ' / ' : '') + (s.name || 'Untitled');

      const meta = document.createElement('span');
      meta.className = 'landing-recent-meta';
      meta.textContent = relativeTime(s.createdAt);

      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(meta);
      li.onclick = () => attachSession(s.id);
      list.appendChild(li);
    }

    landingRecent.innerHTML = '';
    landingRecent.appendChild(header);
    landingRecent.appendChild(list);
  }

  // --- Breadcrumb bar ---
  function updateBreadcrumb() {
    if (!activeSessionId) {
      breadcrumbBar.classList.add('hidden');
      return;
    }
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) {
      breadcrumbBar.classList.add('hidden');
      return;
    }
    const project = projects.find(p => p.id === session.projectId);
    breadcrumbProject.textContent = project ? project.name : 'Unknown';
    breadcrumbSession.textContent = session.name || 'Untitled';
    breadcrumbBar.classList.remove('hidden');
  }

  // --- Toast notifications ---
  function showToast(message, type = 'info', duration = 4000) {
    // Remove existing toast if any
    const existing = document.getElementById('toast');
    if (existing) {
      existing.remove();
      clearTimeout(toastTimeout);
    }

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Confirmation dialog ---
  function showConfirmDialog(title, message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    // Shared cleanup: remove overlay and keydown listener
    const cleanup = () => {
      document.removeEventListener('keydown', handleEscape);
      overlay.remove();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      cleanup();
      if (onCancel) onCancel();
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-ok';
    confirmBtn.textContent = 'Delete Anyway';
    confirmBtn.onclick = () => {
      cleanup();
      if (onConfirm) onConfirm();
    };

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(messageEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        cleanup();
        if (onCancel) onCancel();
      }
    };

    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        if (onCancel) onCancel();
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  // --- Terminal setup ---
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      theme: {
        background: '#2b2a27',
        foreground: '#e8dfd5',
        cursor: '#d97757',
        cursorAccent: '#2b2a27',
        selectionBackground: '#4a4540',
        black: '#2b2a27',
        red: '#d95555',
        green: '#7cba6a',
        yellow: '#d4b87a',
        blue: '#7aadca',
        magenta: '#c97a9c',
        cyan: '#88c8b8',
        white: '#e8dfd5',
        brightBlack: '#8c8478',
        brightRed: '#e06666',
        brightGreen: '#8ece7e',
        brightYellow: '#e0c88e',
        brightBlue: '#8ebdd0',
        brightMagenta: '#d98eb0',
        brightCyan: '#9ed0c4',
        brightWhite: '#fff8f0',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    const webglAddon = new WebglAddon.WebglAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);

    // WebGL addon for sharper rendering on high-DPI displays
    try {
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed, using canvas renderer');
    }

    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'input', data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = debounce(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }
    }, 100);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalEl);

    // Sticky scroll: track user scroll position.
    // Skip during attach (forced auto-scroll) and when a write-triggered scroll
    // is pending — onScroll fires mid-write when baseY increases before viewport
    // catches up, which would incorrectly set sticky=false.
    term.onScroll(() => {
      if (claudeAttachScroll || claudePendingScroll) return;
      const was = claudeSticky;
      claudeSticky = isNearBottom(term);
      if (was && !claudeSticky) {
        console.debug('[scroll] claude: user scrolled away from bottom');
      }
      updateScrollToBottomBtn();
    });

    // Sticky scroll: scroll after writes are parsed
    term.onWriteParsed(() => {
      if (!claudePendingScroll) return;
      claudePendingScroll = false;
      term.scrollToBottom();
      claudeSticky = true;
      updateScrollToBottomBtn();
    });
  }

  function initShellTerminal() {
    shellTerm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      theme: {
        background: '#2b2a27',
        foreground: '#e8dfd5',
        cursor: '#d97757',
        cursorAccent: '#2b2a27',
        selectionBackground: '#4a4540',
        black: '#2b2a27',
        red: '#d95555',
        green: '#7cba6a',
        yellow: '#d4b87a',
        blue: '#7aadca',
        magenta: '#c97a9c',
        cyan: '#88c8b8',
        white: '#e8dfd5',
        brightBlack: '#8c8478',
        brightRed: '#e06666',
        brightGreen: '#8ece7e',
        brightYellow: '#e0c88e',
        brightBlue: '#8ebdd0',
        brightMagenta: '#d98eb0',
        brightCyan: '#9ed0c4',
        brightWhite: '#fff8f0',
      },
    });

    shellFitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    shellTerm.loadAddon(shellFitAddon);
    shellTerm.loadAddon(webLinksAddon);
    shellTerm.open(shellTerminalEl);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      shellTerm.loadAddon(webglAddon);
    } catch (e) {
      console.warn('Shell WebGL addon failed, using canvas renderer');
    }

    shellFitAddon.fit();

    shellTerm.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    shellTerm.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data }));
      }
    });

    const handleShellResize = debounce(() => {
      if (shellFitAddon) {
        shellFitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'shell-resize',
            sessionId: activeSessionId,
            cols: shellTerm.cols,
            rows: shellTerm.rows,
          }));
        }
      }
    }, 100);

    const shellResizeObserver = new ResizeObserver(handleShellResize);
    shellResizeObserver.observe(shellTerminalEl);

    // Sticky scroll: skip during attach and when write-triggered scroll is pending
    shellTerm.onScroll(() => {
      if (shellAttachScroll || shellPendingScroll) return;
      const was = shellSticky;
      shellSticky = isNearBottom(shellTerm);
      if (was && !shellSticky) {
        console.debug('[scroll] shell: user scrolled away from bottom');
      }
    });

    // Sticky scroll: scroll after writes are parsed
    shellTerm.onWriteParsed(() => {
      if (!shellPendingScroll) return;
      shellPendingScroll = false;
      shellTerm.scrollToBottom();
      shellSticky = true;
    });
  }

  // --- WebSocket ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      updateConnectionStatus(true);
      if (activeSessionId) {
        attachSession(activeSessionId);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'output':
          if (msg.sessionId === activeSessionId && msg.data) {
            // During attach, force scroll on every write until output settles
            if (claudeAttachScroll) {
              claudePendingScroll = true;
              clearTimeout(claudeAttachTimer);
              claudeAttachTimer = setTimeout(() => {
                claudeAttachScroll = false;
                claudeSticky = true;
              }, ATTACH_SETTLE_MS);
            } else if (claudeSticky) {
              claudePendingScroll = true;
            }
            term.write(msg.data);
          }
          break;

        case 'replay-done':
          if (msg.sessionId === activeSessionId) {
            // Scroll after write queue drains. Attach auto-scroll stays active
            // to also cover SIGWINCH re-render output arriving after this.
            term.write('', () => {
              requestAnimationFrame(() => {
                term.scrollToBottom();
                claudeSticky = true;
              });
            });
          }
          break;

        case 'state':
          projects = msg.projects;
          sessions = msg.sessions;
          // Reconcile idle state: overwrite with server state and prune stale entries
          {
            const currentSessionIds = new Set(sessions.map(s => s.id));
            for (const [id] of sessionIdleState) {
              if (!currentSessionIds.has(id)) {
                sessionIdleState.delete(id);
              }
            }
            for (const s of sessions) {
              if (s.idle !== undefined) {
                sessionIdleState.set(s.id, s.idle);
              }
            }
          }
          // Reconcile: if active session no longer exists, return to home
          if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
            activeSessionId = null;
            try { localStorage.removeItem('claude-console-active-session'); } catch {}
            term.reset();
            noSession.classList.remove('hidden');
            rightPanel.classList.add('hidden');
            tabBar.classList.remove('visible');
            fileViewer.classList.add('hidden');
            document.getElementById('terminal-wrapper').style.display = '';
            document.getElementById('terminal-wrapper').style.inset = '0';
          }
          // Auto-restore: if no session is active, try to reattach the last
          // active session from localStorage (survives page refresh / app restart).
          if (!activeSessionId) {
            try {
              const saved = localStorage.getItem('claude-console-active-session');
              if (saved && sessions.find((s) => s.id === saved)) {
                attachSession(saved);
              }
            } catch {}
          }
          renderSidebar();
          updateStatusBar();
          updateBreadcrumb();
          if (!activeSessionId) renderLandingRecent();
          break;

        case 'session-deleted':
          sessionIdleState.delete(msg.sessionId);
          if (msg.sessionId === activeSessionId) {
            activeSessionId = null;
            try { localStorage.removeItem('claude-console-active-session'); } catch {}
            term.reset();
            noSession.classList.remove('hidden');
            rightPanel.classList.add('hidden');
            tabBar.classList.remove('visible');
            fileViewer.classList.add('hidden');
            document.getElementById('terminal-wrapper').style.display = '';
            document.getElementById('terminal-wrapper').style.inset = '0';
            updateStatusBar();
            updateBreadcrumb();
            renderLandingRecent();
          }
          break;

        case 'exited':
          // Session still exists, just re-render sidebar to update status dot
          renderSidebar();
          updateStatusBar();
          break;

        case 'session-idle': {
          const { sessionId, idle } = msg;
          const wasWorking = sessionIdleState.get(sessionId) === false;
          sessionIdleState.set(sessionId, idle);
          updateStatusDot(sessionId, idle);
          updateStatusBar();
          // Auto-refresh file tree and git when Claude finishes working
          if (idle && wasWorking && sessionId === activeSessionId) {
            renderFileTreeDir(fileTreeEl, '', 0);
            if (activeRightPanelTab === 'git') {
              refreshGitStatus();
            } else {
              // Show notification dot on Git tab
              setGitTabBadge(true);
            }
          }
          break;
        }

        case 'shell-output':
          if (msg.sessionId === activeSessionId && msg.data) {
            if (shellAttachScroll) {
              shellPendingScroll = true;
              clearTimeout(shellAttachTimer);
              shellAttachTimer = setTimeout(() => {
                shellAttachScroll = false;
                shellSticky = true;
              }, ATTACH_SETTLE_MS);
            } else if (shellSticky) {
              shellPendingScroll = true;
            }
            shellTerm.write(msg.data);
          }
          break;

        case 'shell-replay-done':
          if (msg.sessionId === activeSessionId) {
            shellTerm.write('', () => {
              requestAnimationFrame(() => {
                shellTerm.scrollToBottom();
                shellSticky = true;
              });
            });
          }
          break;
      }
    };

    ws.onclose = () => {
      updateConnectionStatus(false);
      const jitter = reconnectDelay * (0.5 + Math.random());
      setTimeout(connect, jitter);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => { ws.close(); };
  }

  function attachSession(sessionId) {
    activeSessionId = sessionId;
    try { localStorage.setItem('claude-console-active-session', sessionId); } catch {}
    term.reset();
    shellTerm.reset();

    // Enter attach auto-scroll mode: force scroll-to-bottom on every write
    // until output settles (covers replay buffer + SIGWINCH re-render)
    claudeAttachScroll = true;
    claudeSticky = true;
    claudePendingScroll = false;
    clearTimeout(claudeAttachTimer);
    shellAttachScroll = true;
    shellSticky = true;
    shellPendingScroll = false;
    clearTimeout(shellAttachTimer);
    noSession.classList.add('hidden');

    // Show right panel and update path display
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      rightPanel.classList.remove('hidden');
      rightPanelPath.textContent = session.worktreePath || '';
      rightPanelPath.title = session.worktreePath || '';

      // Reset tabs and file tree for new session
      openTabs = [];
      activeTabId = 'claude';
      switchTab('claude');
      renderTabs();
      initFileTree();
    } else {
      rightPanel.classList.add('hidden');
    }

    wsSend(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: term.cols,
      rows: term.rows,
    }));

    // Attach shell terminal
    wsSend(JSON.stringify({
      type: 'shell-attach',
      sessionId,
      cols: shellTerm.cols,
      rows: shellTerm.rows,
    }));

    term.focus();
    renderSidebar();
    updateStatusBar();
    updateBreadcrumb();
  }

  function updateStatusDot(sessionId, idle) {
    const dot = document.querySelector(`[data-session-id="${sessionId}"] .status-dot`);
    if (dot) {
      dot.classList.toggle('active', !idle);
    }
  }

  // --- Sidebar ---
  function renderSidebar() {
    projectListEl.innerHTML = '';

    // Sort projects by createdAt ascending (design spec)
    const sortedProjects = [...projects].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt));

    for (const proj of sortedProjects) {
      const group = document.createElement('div');
      group.className = 'project-group';
      group.dataset.projectId = proj.id;

      // Project header
      const header = document.createElement('div');
      header.className = 'project-header';

      const arrow = document.createElement('span');
      arrow.className = 'project-arrow';
      if (expandedProjects.has(proj.id)) arrow.classList.add('expanded');
      arrow.textContent = '\u25B6';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = proj.name;

      const del = document.createElement('button');
      del.className = 'project-delete';
      del.textContent = '\u00D7';
      del.title = 'Delete project';
      del.onclick = (e) => {
        e.stopPropagation();
        showConfirmDialog(
          'Delete Project',
          `Delete project "${proj.name}" and all its sessions?`,
          () => deleteProject(proj.id)
        );
      };

      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(del);

      header.onclick = () => {
        if (expandedProjects.has(proj.id)) {
          expandedProjects.delete(proj.id);
        } else {
          expandedProjects.add(proj.id);
        }
        renderSidebar();
      };

      group.appendChild(header);

      // Sessions list
      const projSessions = sessions
        .filter((s) => s.projectId === proj.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const ul = document.createElement('ul');
      ul.className = 'project-sessions';
      if (expandedProjects.has(proj.id)) ul.classList.add('expanded');

      for (const s of projSessions) {
        const li = document.createElement('li');
        li.dataset.sessionId = s.id;
        if (s.id === activeSessionId) li.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        if (s.alive) {
          dot.classList.add('alive');
          const idle = sessionIdleState.has(s.id) ? sessionIdleState.get(s.id) : s.idle;
          if (!idle) dot.classList.add('active');
        } else {
          dot.classList.add('exited');
          sessionIdleState.delete(s.id);
        }

        // Session info container (name + optional badges)
        const infoContainer = document.createElement('div');
        infoContainer.className = 'session-info';

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;
        sName.ondblclick = (e) => {
          e.stopPropagation();
          startSessionRename(sName, s.id, s.name);
        };
        infoContainer.appendChild(sName);

        // Provider badge (show for non-default providers)
        if (s.provider && s.provider !== 'claude') {
          const providerBadge = document.createElement('span');
          providerBadge.className = 'provider-badge provider-' + s.provider;
          // Show provider options summary for codex
          let badgeText = s.provider.charAt(0).toUpperCase() + s.provider.slice(1);
          if (s.provider === 'codex' && s.providerOptions) {
            const parts = [];
            if (s.providerOptions.approvalMode) parts.push(s.providerOptions.approvalMode);
            if (s.providerOptions.model) parts.push(s.providerOptions.model);
            if (parts.length) badgeText += ' (' + parts.join(', ') + ')';
          }
          providerBadge.textContent = badgeText;
          infoContainer.appendChild(providerBadge);
        }

        // Branch badge (if session has worktree)
        if (s.branchName) {
          const branchBadge = document.createElement('span');
          branchBadge.className = 'branch-badge';
          branchBadge.textContent = s.branchName;
          branchBadge.title = s.worktreePath || s.branchName;
          infoContainer.appendChild(branchBadge);
        }

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = relativeTime(s.createdAt);

        // Session actions container
        const actions = document.createElement('div');
        actions.className = 'session-actions';

        // Archive button (only show if session has worktree)
        if (s.worktreePath) {
          const sArchive = document.createElement('button');
          sArchive.className = 'session-archive';
          sArchive.innerHTML = '&#128451;'; // Archive icon
          sArchive.title = 'Archive (keep branch, remove worktree)';
          sArchive.onclick = (e) => {
            e.stopPropagation();
            archiveSession(s.id, s.branchName);
          };
          actions.appendChild(sArchive);
        }

        const sDel = document.createElement('button');
        sDel.className = 'session-delete';
        sDel.textContent = '\u00D7';
        sDel.title = 'Delete session';
        sDel.onclick = (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        };
        actions.appendChild(sDel);

        li.appendChild(dot);
        li.appendChild(infoContainer);
        li.appendChild(time);
        li.appendChild(actions);

        li.onclick = async () => {
          if (!s.alive) {
            await restartSession(s.id);
          }
          attachSession(s.id);
        };

        ul.appendChild(li);
      }

      // New session button
      const newBtn = document.createElement('button');
      newBtn.className = 'btn-new-session';
      newBtn.textContent = '+ New Session';
      newBtn.onclick = (e) => {
        e.stopPropagation();
        showInlineSessionInput(ul, proj.id);
      };

      if (expandedProjects.has(proj.id)) {
        ul.appendChild(document.createElement('li')).appendChild(newBtn);
      }

      group.appendChild(ul);
      projectListEl.appendChild(group);
    }
  }

  function showInlineSessionInput(ul, projectId) {
    // Remove any existing inline input
    const existing = ul.querySelector('.inline-session-form');
    if (existing) { existing.remove(); return; }

    const form = document.createElement('div');
    form.className = 'inline-session-form';

    const topRow = document.createElement('div');
    topRow.className = 'inline-session-row';

    const input = document.createElement('input');
    input.className = 'inline-session-input';
    input.type = 'text';
    input.placeholder = 'Session name...';

    const providerToggle = document.createElement('div');
    providerToggle.className = 'provider-toggle-group';
    let selectedProvider = 'claude';

    for (const p of ['claude', 'codex']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'provider-toggle' + (p === 'claude' ? ' active' : '');
      btn.textContent = p.charAt(0).toUpperCase() + p.slice(1);
      btn.dataset.provider = p;
      btn.onclick = (e) => {
        e.stopPropagation();
        selectedProvider = p;
        providerToggle.querySelectorAll('.provider-toggle').forEach(b => b.classList.toggle('active', b.dataset.provider === p));
        codexRow.classList.toggle('hidden', p !== 'codex');
      };
      providerToggle.appendChild(btn);
    }

    topRow.appendChild(input);
    topRow.appendChild(providerToggle);
    form.appendChild(topRow);

    // Codex-specific options row (hidden by default)
    const codexRow = document.createElement('div');
    codexRow.className = 'inline-codex-options hidden';

    const modeSelect = document.createElement('select');
    modeSelect.className = 'inline-provider-select';
    modeSelect.title = 'Approval mode';
    for (const [value, label] of [['suggest', 'Suggest'], ['auto-edit', 'Auto Edit'], ['full-auto', 'Full Auto']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    }

    const modelInput = document.createElement('input');
    modelInput.className = 'inline-session-input';
    modelInput.type = 'text';
    modelInput.placeholder = 'Model (optional)';
    modelInput.title = 'Codex model override (e.g. o4-mini)';

    codexRow.appendChild(modeSelect);
    codexRow.appendChild(modelInput);
    form.appendChild(codexRow);

    ul.insertBefore(form, ul.lastElementChild);
    input.focus();

    const submit = async () => {
      const name = input.value.trim();
      if (!name) return;
      input.disabled = true;
      providerToggle.querySelectorAll('.provider-toggle').forEach(b => b.disabled = true);
      modeSelect.disabled = true;
      modelInput.disabled = true;

      let providerOptions = undefined;
      if (selectedProvider === 'codex') {
        providerOptions = {};
        if (modeSelect.value !== 'suggest') {
          providerOptions.approvalMode = modeSelect.value;
        }
        const model = modelInput.value.trim();
        if (model) {
          providerOptions.model = model;
        }
        // Only send if there are actual options
        if (Object.keys(providerOptions).length === 0) providerOptions = undefined;
      }

      await createSession(projectId, name, selectedProvider, providerOptions);
      form.remove();
    };

    const handleKeydown = async (e) => {
      if (e.key === 'Enter') {
        await submit();
      } else if (e.key === 'Escape') {
        form.remove();
      }
    };

    const handleSelectKeydown = (e) => {
      if (e.key === 'Escape') form.remove();
    };

    input.onkeydown = handleKeydown;
    providerToggle.querySelectorAll('.provider-toggle').forEach(b => b.onkeydown = handleSelectKeydown);
    modeSelect.onkeydown = handleSelectKeydown;
    modelInput.onkeydown = handleKeydown;

    const handleBlur = (e) => {
      if (e.relatedTarget && form.contains(e.relatedTarget)) return;
      setTimeout(() => {
        if (!form.contains(document.activeElement)) form.remove();
      }, 200);
    };

    input.onblur = handleBlur;
    providerToggle.querySelectorAll('.provider-toggle').forEach(b => b.onblur = handleBlur);
    modeSelect.onblur = handleBlur;
    modelInput.onblur = handleBlur;
  }

  function startSessionRename(nameEl, sessionId, currentName) {
    const input = document.createElement('input');
    input.className = 'inline-session-input';
    input.style.margin = '0';
    input.style.width = '100%';
    input.type = 'text';
    input.value = currentName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      }
      // State broadcast will trigger renderSidebar
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        committed = true; // skip commit
        renderSidebar(); // revert
      }
    };

    input.onblur = () => commit();
  }

  // --- API calls ---
  async function createProject(name, cwd) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create project');
      return null;
    }
    return await res.json();
  }

  async function deleteProject(id) {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  }

  async function createSession(projectId, name, provider = 'claude', providerOptions) {
    const body = { name, provider };
    if (providerOptions) body.providerOptions = providerOptions;
    let res;
    try {
      res = await fetch(`/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      showToast('Network error creating session', 'error');
      return null;
    }
    if (!res.ok) {
      const err = await res.json();
      // Handle specific error codes
      let errorMessage = err.error || 'Failed to create session';
      if (err.code === 'WORKTREE_FAILED') {
        errorMessage = 'Failed to create worktree: ' + (err.error || 'Unknown error');
      }
      // Show error inline in sidebar near the project's session list
      const projGroup = projectListEl.querySelector(`[data-project-id="${projectId}"]`);
      if (projGroup) {
        const errEl = document.createElement('div');
        errEl.className = 'inline-error';
        errEl.textContent = errorMessage;
        projGroup.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
      return null;
    }
    const session = await res.json();

    // Show warning toast if .worktrees not in .gitignore
    if (session.warning) {
      showToast(session.warning, 'warning', 6000);
    }

    attachSession(session.id);
    return session;
  }

  async function deleteSession(id, force = false) {
    const url = force ? `/api/sessions/${id}?force=true` : `/api/sessions/${id}`;
    const res = await fetch(url, { method: 'DELETE' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'DIRTY_WORKTREE') {
        // Show confirmation dialog for dirty worktree
        showConfirmDialog(
          'Uncommitted Changes',
          'This session has uncommitted changes. Delete anyway?',
          () => deleteSession(id, true) // Retry with force
        );
        return;
      }
      if (err.code === 'DIRTY_CHECK_FAILED') {
        showConfirmDialog(
          'Cannot Verify',
          'Unable to verify worktree status. Delete anyway?',
          () => deleteSession(id, true)
        );
        return;
      }
      // Show other errors as toast
      showToast(err.error || 'Failed to delete session', 'error');
      return;
    }

    if (activeSessionId === id) {
      activeSessionId = null;
      term.reset();
      noSession.classList.remove('hidden');
      rightPanel.classList.add('hidden');
      tabBar.classList.remove('visible');
      fileViewer.classList.add('hidden');
      document.getElementById('terminal-wrapper').style.display = '';
      document.getElementById('terminal-wrapper').style.inset = '0';
    }
  }

  async function archiveSession(id, branchName, force = false) {
    const url = force
      ? `/api/sessions/${id}/archive?force=true`
      : `/api/sessions/${id}/archive`;
    const res = await fetch(url, { method: 'POST' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'DIRTY_WORKTREE') {
        showConfirmDialog(
          'Uncommitted Changes',
          'This session has uncommitted changes. Archive anyway?',
          () => archiveSession(id, branchName, true)
        );
        return;
      }
      if (err.code === 'DIRTY_CHECK_FAILED') {
        showConfirmDialog(
          'Cannot Verify',
          'Unable to verify worktree status. Archive anyway?',
          () => archiveSession(id, branchName, true)
        );
        return;
      }
      showToast(err.error || 'Failed to archive session', 'error');
      return;
    }

    const result = await res.json();
    const msg = result.branch
      ? `Session archived. Branch "${result.branch}" preserved.`
      : 'Session archived successfully.';
    showToast(msg, 'success');
  }

  async function restartSession(id) {
    const res = await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'WORKTREE_MISSING') {
        showToast('Worktree has been removed. Session cannot be restarted.', 'error');
      } else {
        showToast(err.error || 'Failed to restart session', 'error');
      }
    }
  }

  // --- Directory Browser ---
  let browsePath = '';
  let homedir = ''; // learned from first /api/browse response

  async function loadDir(dirPath) {
    const url = dirPath
      ? `/api/browse?path=${encodeURIComponent(dirPath)}`
      : '/api/browse';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    browsePath = data.path;

    // Learn homedir from default browse (no path param)
    if (!homedir) homedir = data.path;

    // Render breadcrumbs relative to homedir
    dirBreadcrumbs.innerHTML = '';

    // ~ crumb (always clickable, navigates to homedir)
    const homeSpan = document.createElement('span');
    homeSpan.className = 'breadcrumb';
    homeSpan.textContent = '~';
    homeSpan.onclick = () => loadDir('');
    dirBreadcrumbs.appendChild(homeSpan);

    // Only show segments after the homedir prefix
    const relativePath = data.path.startsWith(homedir)
      ? data.path.slice(homedir.length)
      : data.path;
    const segments = relativePath.split('/').filter(Boolean);

    let accumulated = homedir;
    for (const seg of segments) {
      accumulated += '/' + seg;
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '/';
      dirBreadcrumbs.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      crumb.textContent = seg;
      const pathForClick = accumulated;
      crumb.onclick = () => loadDir(pathForClick);
      dirBreadcrumbs.appendChild(crumb);
    }

    // Render directory list
    dirList.innerHTML = '';

    // Parent directory entry (only if we're deeper than homedir)
    if (data.parent && data.path !== homedir) {
      const parentLi = document.createElement('li');
      parentLi.textContent = '..';
      parentLi.onclick = () => loadDir(data.parent);
      dirList.appendChild(parentLi);
    }

    for (const d of data.dirs) {
      const li = document.createElement('li');
      li.textContent = d;
      li.onclick = () => loadDir(data.path + '/' + d);
      dirList.appendChild(li);
    }
  }

  // --- Modal ---
  function openModal() {
    modalProjectName.value = '';
    modalProjectPath.value = '';
    dirBrowser.classList.add('hidden');
    btnModalCreate.disabled = true;
    modalOverlay.classList.remove('hidden');
    modalProjectName.focus();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
  }

  function updateCreateButton() {
    btnModalCreate.disabled = !(modalProjectName.value.trim() && modalProjectPath.value.trim());
  }

  btnAddProject.onclick = openModal;
  btnHomeAddProject.onclick = openModal;

  btnBrowse.onclick = () => {
    if (dirBrowser.classList.contains('hidden')) {
      dirBrowser.classList.remove('hidden');
      loadDir('');
    } else {
      dirBrowser.classList.add('hidden');
    }
  };

  btnSelectDir.onclick = () => {
    modalProjectPath.value = browsePath;
    dirBrowser.classList.add('hidden');
    updateCreateButton();
  };

  btnModalCancel.onclick = closeModal;

  btnModalCreate.onclick = async () => {
    const name = modalProjectName.value.trim();
    const cwd = modalProjectPath.value.trim();
    if (!name || !cwd) return;
    btnModalCreate.disabled = true;
    const proj = await createProject(name, cwd);
    if (proj) {
      expandedProjects.add(proj.id);
      closeModal();
    }
    updateCreateButton();
  };

  modalProjectName.oninput = updateCreateButton;

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  };

  // --- File Tree ---

  async function fetchDirEntries(relativePath) {
    if (!activeSessionId) return { dirs: [], files: [], hasMore: false };
    const params = new URLSearchParams({ sessionId: activeSessionId });
    if (relativePath) params.set('path', relativePath);
    const res = await fetch(`/api/browse?${params}`);
    if (!res.ok) return { dirs: [], files: [], hasMore: false };
    const data = await res.json();
    return {
      dirs: data.dirs || [],
      files: data.files || [],
      hasMore: data.hasMore || false,
    };
  }

  async function renderFileTreeDir(container, relativePath, depth) {
    // Stamp a generation counter so stale async completions are discarded.
    // This prevents collapsed/re-expanded folders from showing stale content.
    const gen = (container._renderGen = (container._renderGen || 0) + 1);

    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'file-tree-loading';
    loading.textContent = 'Loading\u2026';
    container.appendChild(loading);

    const { dirs, files, hasMore } = await fetchDirEntries(relativePath);

    // Bail if a newer render (or a collapse) superseded this one
    if (container._renderGen !== gen) return;

    container.innerHTML = '';

    const indent = depth * 16;

    // Render directories first
    for (const dir of dirs) {
      const dirPath = relativePath ? relativePath + '/' + dir : dir;
      const item = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'file-tree-item file-tree-folder';
      row.style.paddingLeft = indent + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      arrow.textContent = expandedDirs.has(dirPath) ? '\u25BC' : '\u25B6';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = dir;

      row.appendChild(arrow);
      row.appendChild(label);

      const children = document.createElement('div');
      children.className = 'file-tree-children';
      if (expandedDirs.has(dirPath)) {
        children.classList.add('expanded');
        renderFileTreeDir(children, dirPath, depth + 1);
      }

      row.onclick = () => {
        if (expandedDirs.has(dirPath)) {
          expandedDirs.delete(dirPath);
          arrow.textContent = '\u25B6';
          children.classList.remove('expanded');
          // Bump generation to cancel any in-flight async render
          children._renderGen = (children._renderGen || 0) + 1;
          children.innerHTML = '';
        } else {
          expandedDirs.add(dirPath);
          arrow.textContent = '\u25BC';
          children.classList.add('expanded');
          renderFileTreeDir(children, dirPath, depth + 1);
        }
      };

      item.appendChild(row);
      item.appendChild(children);
      container.appendChild(item);
    }

    // Render files
    for (const file of files) {
      const filePath = relativePath ? relativePath + '/' + file : file;

      const row = document.createElement('div');
      row.className = 'file-tree-item';
      row.style.paddingLeft = (indent + 16) + 'px';

      const icon = createFileIcon(file);
      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = file;
      label.title = filePath;

      row.appendChild(icon);
      row.appendChild(label);
      row.onclick = () => openFileTab(filePath, file);
      container.appendChild(row);
    }

    // "Show more" indicator when entries were truncated
    if (hasMore) {
      const more = document.createElement('div');
      more.className = 'file-tree-more';
      more.style.paddingLeft = indent + 'px';
      more.textContent = 'More entries not shown\u2026';
      container.appendChild(more);
    }

    // Show message if empty
    if (dirs.length === 0 && files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-tree-loading';
      empty.textContent = 'Empty directory';
      container.appendChild(empty);
    }

    // Re-apply git status badges after tree content updates
    if (gitFileStatusMap.size > 0) applyFileTreeGitBadges();
  }

  function applyFileTreeGitBadges() {
    // Annotate file tree items with git status badges
    const items = fileTreeEl.querySelectorAll('.file-tree-item:not(.file-tree-folder)');
    items.forEach(item => {
      // Remove existing badge
      const old = item.querySelector('.file-tree-git-badge');
      if (old) old.remove();

      const label = item.querySelector('.file-tree-label');
      if (!label) return;
      const path = label.title || label.textContent;
      const status = gitFileStatusMap.get(path);
      if (status) {
        const badge = document.createElement('span');
        badge.className = `file-tree-git-badge git-status-${status.toLowerCase()}`;
        badge.textContent = status;
        badge.title = STATUS_LABELS[status] || status;
        item.appendChild(badge);
      }
    });
  }

  function initFileTree() {
    if (!activeSessionId) {
      fileTreeEl.innerHTML = '';
      return;
    }
    expandedDirs.clear();
    renderFileTreeDir(fileTreeEl, '', 0);
  }

  // File tree collapse/expand toggle
  btnToggleFileTree.onclick = () => {
    const isCollapsed = fileTreeSection.classList.toggle('collapsed');
    btnToggleFileTree.innerHTML = isCollapsed ? '&#x25B6;' : '&#x25BC;';
    btnToggleFileTree.title = isCollapsed ? 'Expand file tree' : 'Collapse file tree';
    // Refit shell terminal after layout change
    requestAnimationFrame(() => {
      if (shellFitAddon) shellFitAddon.fit();
    });
  };

  // File tree refresh button
  btnRefreshFileTree.onclick = () => {
    if (!activeSessionId) return;
    renderFileTreeDir(fileTreeEl, '', 0);
  };

  // --- Tab System ---

  function renderTabs() {
    if (!activeSessionId) {
      tabBar.classList.remove('visible');
      return;
    }
    tabBar.classList.add('visible');
    tabList.innerHTML = '';

    // Provider tab (always first, never closeable) — label matches active session's provider
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    const providerName = activeSession && activeSession.provider === 'codex' ? 'Codex' : 'Claude';
    const claudeTab = document.createElement('div');
    claudeTab.className = 'tab' + (activeTabId === 'claude' ? ' active' : '');
    const claudeLabel = document.createElement('span');
    claudeLabel.className = 'tab-label';
    claudeLabel.textContent = providerName;
    claudeTab.appendChild(claudeLabel);
    claudeTab.onclick = () => switchTab('claude');
    tabList.appendChild(claudeTab);

    // File tabs — render pinned first, then unpinned
    const sortedTabs = [...openTabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    // Reorder openTabs in-place to match sorted order
    sortedTabs.forEach((t, idx) => { openTabs[idx] = t; });

    for (let i = 0; i < openTabs.length; i++) {
      const tab = openTabs[i];
      const el = document.createElement('div');
      el.className = 'tab' + (activeTabId === tab.id ? ' active' : '') + (tab.pinned ? ' tab-pinned' : '');
      el.title = tab.fullPath;

      // File type icon
      const origName = tab.fullPath ? tab.fullPath.split('/').pop() : tab.filename;
      const tabIcon = createFileIcon(origName, 'tab-icon');
      el.appendChild(tabIcon);

      if (!tab.pinned) {
        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = tab.filename;
        el.appendChild(label);
      }

      // Diff stats badge (only for unpinned)
      if (tab.diffStats && !tab.pinned) {
        const stats = document.createElement('span');
        stats.className = 'tab-diff-stats';
        const parts = [];
        if (tab.diffStats.added) parts.push(`<span class="tab-diff-add">+${tab.diffStats.added}</span>`);
        if (tab.diffStats.removed) parts.push(`<span class="tab-diff-del">-${tab.diffStats.removed}</span>`);
        if (parts.length) stats.innerHTML = parts.join(' ');
        el.appendChild(stats);
      }

      // Close button (not for pinned tabs)
      if (!tab.pinned) {
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.textContent = '\u00D7';
        close.onclick = (e) => {
          e.stopPropagation();
          closeTab(tab.id);
        };
        el.appendChild(close);
      }

      el.onclick = () => switchTab(tab.id);
      el.oncontextmenu = (e) => {
        e.preventDefault();
        showTabContextMenu(e, tab);
      };

      // Drag-and-drop reordering
      el.draggable = true;
      el.dataset.tabIndex = String(i);
      el.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', String(i));
        el.classList.add('tab-dragging');
      };
      el.ondragend = () => {
        el.classList.remove('tab-dragging');
        tabList.querySelectorAll('.tab-drop-before, .tab-drop-after').forEach(t => {
          t.classList.remove('tab-drop-before', 'tab-drop-after');
        });
      };
      el.ondragover = (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        el.classList.toggle('tab-drop-before', e.clientX < mid);
        el.classList.toggle('tab-drop-after', e.clientX >= mid);
      };
      el.ondragleave = () => {
        el.classList.remove('tab-drop-before', 'tab-drop-after');
      };
      el.ondrop = (e) => {
        e.preventDefault();
        el.classList.remove('tab-drop-before', 'tab-drop-after');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const toIdx = parseInt(el.dataset.tabIndex);
        if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
        const moved = openTabs.splice(fromIdx, 1)[0];
        openTabs.splice(toIdx > fromIdx ? toIdx : toIdx, 0, moved);
        renderTabs();
      };

      tabList.appendChild(el);
    }
  }

  function getTopInset() {
    const tabH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tab-bar-height')) || 32;
    const bcH = breadcrumbBar && !breadcrumbBar.classList.contains('hidden')
      ? breadcrumbBar.offsetHeight : 0;
    return (tabH + bcH) + 'px';
  }

  function getBottomInset() {
    return statusBar && !statusBar.classList.contains('hidden') ? '24px' : '0';
  }

  function switchTab(tabId) {
    activeTabId = tabId;
    renderTabs();
    closeFvSearch();
    if (fileViewerEditing) exitEditMode(true);

    const termWrapper = document.getElementById('terminal-wrapper');

    if (tabId === 'claude') {
      // Show terminal, hide file viewer
      termWrapper.style.display = '';
      termWrapper.style.inset = `${getTopInset()} 0 ${getBottomInset()} 0`;
      fileViewer.classList.add('hidden');
      updateScrollToBottomBtn();
      term.focus();
      // Refit terminal synchronously so term.cols/rows are correct before
      // attachSession() sends the attach message with dimensions.
      // Reading clientWidth/clientHeight forces a reflow after the inset change.
      if (fitAddon) fitAddon.fit();
    } else {
      // Show file viewer, hide terminal
      termWrapper.style.display = 'none';
      fileViewer.classList.remove('hidden');
      fileViewer.style.inset = `${getTopInset()} 0 ${getBottomInset()} 0`;
      scrollToBottomBtn.classList.add('hidden');

      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        renderFileContent(tab);
      }
    }
  }

  function closeTab(tabId) {
    const tab = openTabs.find(t => t.id === tabId);
    if (tab && tab.pinned) return; // can't close pinned tabs
    openTabs = openTabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = openTabs.length > 0 ? openTabs[openTabs.length - 1].id : 'claude';
    }
    switchTab(activeTabId);
  }

  function closeOtherTabs(tabId) {
    openTabs = openTabs.filter(t => t.id === tabId);
    activeTabId = tabId;
    switchTab(activeTabId);
  }

  function closeAllTabs() {
    const pinned = openTabs.filter(t => t.pinned);
    openTabs = pinned;
    if (!openTabs.find(t => t.id === activeTabId)) {
      activeTabId = openTabs.length > 0 ? openTabs[0].id : 'claude';
    }
    switchTab(activeTabId);
  }

  function showTabContextMenu(e, tab) {
    // Remove any existing context menu
    const existing = document.getElementById('tab-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.className = 'context-menu';

    const items = [
      { label: tab.pinned ? 'Unpin' : 'Pin', action: () => { tab.pinned = !tab.pinned; renderTabs(); } },
      { label: 'Close', action: () => closeTab(tab.id), disabled: tab.pinned },
      { label: 'Close Others', action: () => closeOtherTabs(tab.id), disabled: openTabs.length <= 1 },
      { label: 'Close All Unpinned', action: () => closeAllTabs() },
      { type: 'separator' },
      { label: 'Copy Path', action: () => { navigator.clipboard.writeText(tab.fullPath).catch(() => {}); showToast('Path copied', 'info', 2000); } },
    ];

    for (const item of items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'context-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      if (item.disabled) row.classList.add('disabled');
      row.textContent = item.label;
      if (!item.disabled) {
        row.onclick = () => { menu.remove(); item.action(); };
      }
      menu.appendChild(row);
    }

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);

    // Adjust if overflowing viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    // Close on click outside or Escape
    const cleanup = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', cleanup); document.removeEventListener('keydown', escCleanup); }
    };
    const escCleanup = (ev) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', cleanup); document.removeEventListener('keydown', escCleanup); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', cleanup);
      document.addEventListener('keydown', escCleanup);
    }, 0);
  }

  const pendingFileOpens = new Set();

  async function openFileTab(filePath, filename) {
    // Check if already open
    const existing = openTabs.find(t => t.id === filePath);
    if (existing) {
      switchTab(existing.id);
      return;
    }

    // Guard against duplicate concurrent fetches (e.g. double-click)
    if (pendingFileOpens.has(filePath)) return;
    pendingFileOpens.add(filePath);

    // Capture session ID now — if the user switches sessions while the
    // fetch is in-flight we must discard the result rather than mixing
    // file content from one session into another session's tab list.
    const sessionId = activeSessionId;

    // Fetch file content
    let res;
    try {
      res = await fetch(`/api/file?sessionId=${sessionId}&path=${encodeURIComponent(filePath)}`);
    } finally {
      pendingFileOpens.delete(filePath);
    }

    // Discard result if user switched sessions during the fetch
    if (activeSessionId !== sessionId) return;

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to load file' }));
      showToast(err.error || 'Failed to load file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    let tab;

    if (contentType.includes('application/json')) {
      // JSON response — either a binary file indicator or unexpected payload
      const data = await res.json();
      if (data.isBinary) {
        tab = { id: filePath, filename, fullPath: filePath, content: null, type: 'binary' };
      } else {
        showToast('Unsupported file type', 'error');
        return;
      }
    } else {
      const content = await res.text();
      const ext = filename.split('.').pop().toLowerCase();
      const type = (ext === 'md' || ext === 'markdown') ? 'markdown' : 'text';
      tab = { id: filePath, filename, fullPath: filePath, content, type };
    }

    if (tab) {
      openTabs.push(tab);
      switchTab(tab.id);
    }
  }

  function renderFileViewerBreadcrumb(fullPath) {
    fileViewerPath.innerHTML = '';
    const parts = fullPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'fv-path-sep';
        sep.textContent = '/';
        fileViewerPath.appendChild(sep);
      }
      const segment = document.createElement('span');
      segment.className = 'fv-path-segment';
      segment.textContent = parts[i];
      if (i < parts.length - 1) {
        // Clicking a directory segment expands it in the file tree
        const dirPath = parts.slice(0, i + 1).join('/');
        segment.classList.add('fv-path-clickable');
        segment.onclick = () => {
          if (!expandedDirs.has(dirPath)) {
            expandedDirs.add(dirPath);
            renderFileTreeDir(fileTreeEl, '', 0);
          }
          // Switch to files tab if on git tab
          if (activeRightPanelTab !== 'files') {
            const filesTab = rightPanelTabs.querySelector('[data-rp-tab="files"]');
            if (filesTab) filesTab.click();
          }
        };
      }
      fileViewerPath.appendChild(segment);
    }
  }

  function renderFileContent(tab) {
    renderFileViewerBreadcrumb(tab.fullPath);
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = '';

    if (tab.type === 'binary') {
      fileViewerContent.className = 'binary-file';
      fileViewerContent.textContent = 'Binary file \u2014 not supported';
      return;
    }

    if (tab.type === 'markdown') {
      fileViewerContent.className = 'markdown-body';
      const rawHtml = marked.parse(tab.content);
      fileViewerContent.innerHTML = DOMPurify.sanitize(rawHtml);
      return;
    }

    if (tab.type === 'diff') {
      fileViewerContent.className = 'diff-view';
      const lines = tab.content.split('\n');
      for (const line of lines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineEl.classList.add('diff-add');
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          lineEl.classList.add('diff-del');
        } else if (line.startsWith('@@')) {
          lineEl.classList.add('diff-hunk');
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          lineEl.classList.add('diff-header');
        }
        lineEl.textContent = line;
        fileViewerContent.appendChild(lineEl);
      }
      return;
    }

    // Plain text with line numbers
    fileViewerContent.className = 'plain-text';
    const lines = tab.content.split('\n');
    const gutter = document.createElement('div');
    gutter.className = 'line-numbers';
    gutter.textContent = lines.map((_, i) => i + 1).join('\n');
    const code = document.createElement('div');
    code.className = 'line-content';
    code.textContent = tab.content;
    fileViewerContent.appendChild(gutter);
    fileViewerContent.appendChild(code);
  }

  // Refresh button handler
  fileViewerRefresh.onclick = async () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'binary') return;

    let res;
    try {
      res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}`);
    } catch {
      showToast('Network error refreshing file', 'error');
      return;
    }
    if (!res.ok) {
      showToast('Failed to refresh file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.isBinary) {
        tab.type = 'binary';
        tab.content = null;
      }
    } else {
      tab.content = await res.text();
    }

    renderFileContent(tab);
  };

  // Word wrap toggle
  fileViewerWrap.onclick = () => {
    fileViewerWordWrap = !fileViewerWordWrap;
    fileViewerWrap.classList.toggle('fv-btn-active', fileViewerWordWrap);
    fileViewerContent.classList.toggle('word-wrap', fileViewerWordWrap);
  };

  // Copy file content
  fileViewerCopy.onclick = () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content) return;
    navigator.clipboard.writeText(tab.content).then(
      () => showToast('Copied to clipboard', 'info', 2000),
      () => showToast('Failed to copy', 'error', 2000)
    );
  };

  // --- Inline file editing ---

  function enterEditMode() {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content || tab.type === 'binary' || tab.type === 'diff') return;

    fileViewerEditing = true;
    fileViewerEdit.classList.add('hidden');
    fileViewerSave.classList.remove('hidden');
    fileViewerCancelEdit.classList.remove('hidden');

    // Replace content with textarea
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = 'editing';
    const textarea = document.createElement('textarea');
    textarea.id = 'fv-editor';
    textarea.className = 'fv-editor';
    textarea.value = tab.content;
    textarea.spellcheck = false;
    fileViewerContent.appendChild(textarea);
    textarea.focus();
  }

  function exitEditMode(restoreContent) {
    fileViewerEditing = false;
    fileViewerEdit.classList.remove('hidden');
    fileViewerSave.classList.add('hidden');
    fileViewerCancelEdit.classList.add('hidden');

    if (restoreContent) {
      const tab = openTabs.find(t => t.id === activeTabId);
      if (tab) renderFileContent(tab);
    }
  }

  fileViewerEdit.onclick = enterEditMode;
  fileViewerCancelEdit.onclick = () => exitEditMode(true);

  fileViewerSave.onclick = async () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab) return;

    const editor = document.getElementById('fv-editor');
    if (!editor) return;

    const newContent = editor.value;
    fileViewerSave.disabled = true;
    fileViewerSave.textContent = 'Saving\u2026';

    try {
      const res = await fetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          path: tab.fullPath,
          content: newContent,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to save file', 'error');
        return;
      }

      // Update tab content and exit edit mode
      tab.content = newContent;
      showToast('File saved', 'success', 2000);
      exitEditMode(true);
    } catch {
      showToast('Network error saving file', 'error');
    } finally {
      fileViewerSave.disabled = false;
      fileViewerSave.textContent = 'Save';
    }
  };

  // --- File viewer search ---

  function openFvSearch() {
    if (activeTabId === 'claude') return; // only for file tabs
    fvSearchBar.classList.remove('hidden');
    fvSearchInput.focus();
    fvSearchInput.select();
  }

  function closeFvSearch() {
    fvSearchBar.classList.add('hidden');
    fvSearchInput.value = '';
    clearFvSearchHighlights();
    fvSearchCount.textContent = '';
    fvSearchMatches = [];
    fvSearchCurrentIdx = -1;
  }

  function performFvSearch(query) {
    clearFvSearchHighlights();
    fvSearchMatches = [];
    fvSearchCurrentIdx = -1;
    if (!query) {
      fvSearchCount.textContent = '';
      return;
    }

    const lowerQuery = query.toLowerCase();
    // Walk text nodes in fileViewerContent and highlight matches
    const walker = document.createTreeWalker(fileViewerContent, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const text = node.textContent;
      const lower = text.toLowerCase();
      let idx = 0;
      const parts = [];
      let lastEnd = 0;

      while ((idx = lower.indexOf(lowerQuery, idx)) !== -1) {
        if (idx > lastEnd) {
          parts.push({ text: text.slice(lastEnd, idx), match: false });
        }
        parts.push({ text: text.slice(idx, idx + query.length), match: true });
        lastEnd = idx + query.length;
        idx = lastEnd;
      }

      if (parts.length > 0) {
        if (lastEnd < text.length) {
          parts.push({ text: text.slice(lastEnd), match: false });
        }
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (p.match) {
            const mark = document.createElement('mark');
            mark.className = 'fv-search-match';
            mark.textContent = p.text;
            fvSearchMatches.push(mark);
            frag.appendChild(mark);
          } else {
            frag.appendChild(document.createTextNode(p.text));
          }
        }
        node.parentNode.replaceChild(frag, node);
      }
    }

    if (fvSearchMatches.length > 0) {
      fvSearchCurrentIdx = 0;
      fvSearchMatches[0].classList.add('fv-search-current');
      fvSearchMatches[0].scrollIntoView({ block: 'center' });
      fvSearchCount.textContent = `1 of ${fvSearchMatches.length}`;
    } else {
      fvSearchCount.textContent = 'No results';
    }
  }

  function clearFvSearchHighlights() {
    const marks = fileViewerContent.querySelectorAll('mark.fv-search-match');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize(); // merge adjacent text nodes
    });
    fvSearchMatches = [];
    fvSearchCurrentIdx = -1;
  }

  function navigateFvSearch(delta) {
    if (fvSearchMatches.length === 0) return;
    fvSearchMatches[fvSearchCurrentIdx].classList.remove('fv-search-current');
    fvSearchCurrentIdx = (fvSearchCurrentIdx + delta + fvSearchMatches.length) % fvSearchMatches.length;
    fvSearchMatches[fvSearchCurrentIdx].classList.add('fv-search-current');
    fvSearchMatches[fvSearchCurrentIdx].scrollIntoView({ block: 'center' });
    fvSearchCount.textContent = `${fvSearchCurrentIdx + 1} of ${fvSearchMatches.length}`;
  }

  fvSearchInput.oninput = debounce(() => {
    performFvSearch(fvSearchInput.value.trim());
  }, 200);

  fvSearchInput.onkeydown = (e) => {
    if (e.key === 'Escape') { closeFvSearch(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFvSearch(e.shiftKey ? -1 : 1);
    }
  };

  fvSearchNext.onclick = () => navigateFvSearch(1);
  fvSearchPrev.onclick = () => navigateFvSearch(-1);
  fvSearchClose.onclick = closeFvSearch;

  // Keyboard shortcuts (only when terminal is NOT focused)
  document.addEventListener('keydown', (e) => {
    const inTerminal = terminalEl.contains(document.activeElement) ||
                       shellTerminalEl.contains(document.activeElement);
    if (inTerminal) return;

    // Ctrl+F — open file viewer search (only when viewing a file)
    if (e.key === 'f' && (e.ctrlKey || e.metaKey) && activeTabId !== 'claude') {
      e.preventDefault();
      openFvSearch();
      return;
    }

    if (e.altKey && e.key === 'Tab') {
      e.preventDefault();
      const allIds = ['claude', ...openTabs.map(t => t.id)];
      const idx = allIds.indexOf(activeTabId);
      const nextIdx = (idx + 1) % allIds.length;
      switchTab(allIds[nextIdx]);
    }

    if (e.altKey && e.key === 'w') {
      e.preventDefault();
      if (activeTabId !== 'claude') {
        closeTab(activeTabId);
      }
    }
  });

  // --- Right Panel Tab Switching (Files / Git) ---

  rightPanelTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.rp-tab');
    if (!btn) return;
    const tab = btn.dataset.rpTab;
    if (tab === activeRightPanelTab) return;
    activeRightPanelTab = tab;
    rightPanelTabs.querySelectorAll('.rp-tab').forEach(b => b.classList.toggle('active', b.dataset.rpTab === tab));
    const searchBox = document.querySelector('.file-tree-search');
    if (tab === 'files') {
      fileTreeEl.classList.remove('hidden');
      gitPanel.classList.add('hidden');
      btnRefreshFileTree.style.display = '';
      btnToggleFileTree.style.display = '';
      if (searchBox) searchBox.style.display = '';
    } else {
      fileTreeEl.classList.add('hidden');
      gitPanel.classList.remove('hidden');
      btnRefreshFileTree.style.display = 'none';
      btnToggleFileTree.style.display = 'none';
      if (searchBox) searchBox.style.display = 'none';
      setGitTabBadge(false);
      refreshGitStatus();
    }
  });

  // --- Git Panel ---

  const STATUS_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Unmerged' };

  async function refreshGitStatus() {
    if (!activeSessionId) return;
    gitFileList.innerHTML = '<div class="git-loading">Loading...</div>';
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/status`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errDiv = document.createElement('div');
        errDiv.className = 'git-loading';
        errDiv.textContent = err.error || 'Failed to load status';
        gitFileList.innerHTML = '';
        gitFileList.appendChild(errDiv);
        return;
      }
      const data = await res.json();
      renderGitStatus(data);
      refreshGitLog();
    } catch (e) {
      gitFileList.innerHTML = '<div class="git-loading">Failed to load status</div>';
    }
  }

  function renderGitStatus(data) {
    gitBranchName.textContent = data.branch || 'unknown';
    gitBranchName.title = data.branch || '';

    const parts = [];
    if (data.ahead > 0) parts.push(`+${data.ahead}`);
    if (data.behind > 0) parts.push(`-${data.behind}`);
    gitAheadBehind.textContent = parts.join(' ');

    // Build file status map for tree change indicators
    gitFileStatusMap = new Map();
    for (const f of data.staged) gitFileStatusMap.set(f.path, f.status);
    for (const f of data.unstaged) {
      if (!gitFileStatusMap.has(f.path)) gitFileStatusMap.set(f.path, f.status);
    }
    for (const f of data.untracked) gitFileStatusMap.set(f, '?');
    // Update file tree badges
    applyFileTreeGitBadges();

    // Update status bar changes counter
    updateStatusChangesCount(data);

    // Enable/disable commit button based on staged files
    btnGitCommit.disabled = data.staged.length === 0;

    gitFileList.innerHTML = '';

    const hasChanges = data.staged.length > 0 || data.unstaged.length > 0 || data.untracked.length > 0;

    if (!hasChanges) {
      gitFileList.innerHTML = '<div class="git-empty">No changes</div>';
      return;
    }

    // Staged section
    if (data.staged.length > 0) {
      const section = createGitSection('Staged Changes', data.staged.length, 'staged');
      const stageAll = section.querySelector('.git-section-action');
      stageAll.textContent = 'Unstage All';
      stageAll.onclick = () => gitUnstageAll();
      for (const f of data.staged) {
        section.querySelector('.git-section-files').appendChild(
          createGitFileRow(f.path, f.status, 'staged')
        );
      }
      gitFileList.appendChild(section);
    }

    // Unstaged section
    if (data.unstaged.length > 0) {
      const section = createGitSection('Changes', data.unstaged.length, 'unstaged');
      const stageAll = section.querySelector('.git-section-action');
      stageAll.textContent = 'Stage All';
      stageAll.onclick = () => gitStageAll();
      for (const f of data.unstaged) {
        section.querySelector('.git-section-files').appendChild(
          createGitFileRow(f.path, f.status, 'unstaged')
        );
      }
      gitFileList.appendChild(section);
    }

    // Untracked section
    if (data.untracked.length > 0) {
      const section = createGitSection('Untracked', data.untracked.length, 'untracked');
      const stageAll = section.querySelector('.git-section-action');
      stageAll.textContent = 'Stage All';
      stageAll.onclick = () => gitStageFiles(data.untracked);
      for (const f of data.untracked) {
        section.querySelector('.git-section-files').appendChild(
          createGitFileRow(f, '?', 'untracked')
        );
      }
      gitFileList.appendChild(section);
    }
  }

  function createGitSection(title, count, type) {
    const section = document.createElement('div');
    section.className = 'git-section';

    const header = document.createElement('div');
    header.className = 'git-section-header';

    const label = document.createElement('span');
    label.className = 'git-section-label';
    label.textContent = `${title} (${count})`;

    const action = document.createElement('button');
    action.className = 'git-section-action';

    header.appendChild(label);
    header.appendChild(action);

    const files = document.createElement('div');
    files.className = 'git-section-files';

    section.appendChild(header);
    section.appendChild(files);
    return section;
  }

  function createGitFileRow(filePath, status, type) {
    const row = document.createElement('div');
    row.className = 'git-file-row';

    const statusBadge = document.createElement('span');
    statusBadge.className = `git-status-badge git-status-${status.toLowerCase()}`;
    statusBadge.textContent = status;
    statusBadge.title = STATUS_LABELS[status] || status;

    const name = document.createElement('span');
    name.className = 'git-file-name';
    name.textContent = filePath;
    name.title = filePath;

    const actions = document.createElement('div');
    actions.className = 'git-file-actions';

    if (type === 'staged') {
      // View diff button
      const diffBtn = document.createElement('button');
      diffBtn.className = 'git-file-action';
      diffBtn.textContent = 'Diff';
      diffBtn.title = 'View staged diff';
      diffBtn.onclick = (e) => { e.stopPropagation(); viewGitDiff(filePath, true); };
      actions.appendChild(diffBtn);

      // Unstage button
      const unstageBtn = document.createElement('button');
      unstageBtn.className = 'git-file-action';
      unstageBtn.textContent = '\u2212'; // minus sign
      unstageBtn.title = 'Unstage file';
      unstageBtn.onclick = (e) => { e.stopPropagation(); gitUnstageFiles([filePath]); };
      actions.appendChild(unstageBtn);
    } else if (type === 'unstaged') {
      // View diff button
      const diffBtn = document.createElement('button');
      diffBtn.className = 'git-file-action';
      diffBtn.textContent = 'Diff';
      diffBtn.title = 'View unstaged diff';
      diffBtn.onclick = (e) => { e.stopPropagation(); viewGitDiff(filePath, false); };
      actions.appendChild(diffBtn);

      // Discard button
      const discardBtn = document.createElement('button');
      discardBtn.className = 'git-file-action git-action-danger';
      discardBtn.textContent = '\u21A9'; // ↩
      discardBtn.title = 'Discard changes';
      discardBtn.onclick = (e) => {
        e.stopPropagation();
        showConfirmDialog('Discard Changes', `Discard changes to "${filePath}"?`, () => gitDiscardFiles([filePath]));
      };
      actions.appendChild(discardBtn);

      // Stage button
      const stageBtn = document.createElement('button');
      stageBtn.className = 'git-file-action';
      stageBtn.textContent = '+';
      stageBtn.title = 'Stage file';
      stageBtn.onclick = (e) => { e.stopPropagation(); gitStageFiles([filePath]); };
      actions.appendChild(stageBtn);
    } else if (type === 'untracked') {
      // Stage button
      const stageBtn = document.createElement('button');
      stageBtn.className = 'git-file-action';
      stageBtn.textContent = '+';
      stageBtn.title = 'Stage file';
      stageBtn.onclick = (e) => { e.stopPropagation(); gitStageFiles([filePath]); };
      actions.appendChild(stageBtn);
    }

    row.appendChild(statusBadge);
    row.appendChild(name);
    row.appendChild(actions);

    // Click row to view diff (for tracked files)
    if (type !== 'untracked') {
      row.style.cursor = 'pointer';
      row.onclick = () => viewGitDiff(filePath, type === 'staged');
    }

    return row;
  }

  // --- Git Actions ---

  async function gitStageFiles(paths) {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to stage files', 'error');
        return;
      }
      refreshGitStatus();
    } catch {
      showToast('Failed to stage files', 'error');
    }
  }

  async function gitStageAll() {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to stage all', 'error');
        return;
      }
      refreshGitStatus();
    } catch {
      showToast('Failed to stage all', 'error');
    }
  }

  async function gitUnstageFiles(paths) {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/unstage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to unstage files', 'error');
        return;
      }
      refreshGitStatus();
    } catch {
      showToast('Failed to unstage files', 'error');
    }
  }

  async function gitUnstageAll() {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/unstage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to unstage all', 'error');
        return;
      }
      refreshGitStatus();
    } catch {
      showToast('Failed to unstage all', 'error');
    }
  }

  async function gitDiscardFiles(paths) {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to discard changes', 'error');
        return;
      }
      refreshGitStatus();
    } catch {
      showToast('Failed to discard changes', 'error');
    }
  }

  async function gitCommit() {
    if (!activeSessionId) return;
    const message = gitCommitMessage.value.trim();
    if (!message) return;

    btnGitCommit.disabled = true;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Commit failed', 'error');
        btnGitCommit.disabled = false;
        return;
      }
      const data = await res.json();
      gitCommitMessage.value = '';
      showToast(`Committed: ${data.commit.shortHash} ${data.commit.message}`, 'success');
      refreshGitStatus();
    } catch {
      showToast('Commit failed', 'error');
      btnGitCommit.disabled = false;
    }
  }

  btnGitCommit.onclick = gitCommit;

  gitCommitMessage.onkeydown = (e) => {
    if (e.key === 'Enter' && !btnGitCommit.disabled) {
      e.preventDefault();
      gitCommit();
    }
  };

  gitCommitMessage.oninput = () => {
    // Re-enable commit button if there's text (actual staged check happens on commit)
    // Keeps button responsive while typing
  };

  btnGitRefresh.onclick = refreshGitStatus;

  // --- Merge to Main ---

  btnGitMerge.onclick = () => {
    const branch = gitBranchName.textContent || 'this branch';
    showConfirmDialog(
      'Merge to Main',
      `Merge "${branch}" into the default branch (main/master)? All committed changes will be applied.`,
      gitMergeToMain
    );
  };

  async function gitMergeToMain() {
    if (!activeSessionId) return;

    btnGitMerge.disabled = true;
    btnGitMerge.textContent = 'Merging...';

    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/merge-to-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.code === 'MERGE_CONFLICT') {
          showToast('Merge conflict! Resolve manually in the shell terminal.', 'warning', 6000);
        } else if (data.code === 'DIRTY_WORKTREE') {
          showToast('Commit or discard changes before merging.', 'warning');
        } else {
          showToast(data.error || 'Merge failed', 'error');
        }
        return;
      }

      showToast(
        `Merged ${data.mergedBranch} into ${data.targetBranch} (${data.commit.shortHash})`,
        'success',
        6000
      );
      refreshGitStatus();
    } catch {
      showToast('Merge failed', 'error');
    } finally {
      btnGitMerge.disabled = false;
      btnGitMerge.textContent = 'Merge to Main';
    }
  }

  // --- Git Diff Viewer ---

  async function viewGitDiff(filePath, staged) {
    if (!activeSessionId) return;

    const params = new URLSearchParams({ path: filePath });
    if (staged) params.set('staged', 'true');

    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/diff?${params}`);
      if (!res.ok) {
        showToast('Failed to load diff', 'error');
        return;
      }
      const data = await res.json();
      if (!data.diff.trim()) {
        showToast('No diff available', 'info');
        return;
      }
      openDiffTab(filePath, data.diff, staged);
    } catch {
      showToast('Failed to load diff', 'error');
    }
  }

  function countDiffStats(diff) {
    let added = 0, removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
  }

  function openDiffTab(filePath, diff, staged) {
    const tabId = `diff:${staged ? 'staged' : 'unstaged'}:${filePath}`;
    const filename = filePath.split('/').pop();
    const tabTitle = `${filename} (${staged ? 'staged' : 'diff'})`;

    // Remove existing diff tab for the same file/mode
    openTabs = openTabs.filter(t => t.id !== tabId);

    const stats = countDiffStats(diff);
    const tab = {
      id: tabId,
      filename: tabTitle,
      fullPath: filePath,
      content: diff,
      type: 'diff',
      diffStats: stats,
    };
    openTabs.push(tab);
    switchTab(tab.id);
  }

  // --- Git Log ---

  async function refreshGitLog() {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/git/log?limit=30`);
      if (!res.ok) return;
      const data = await res.json();
      renderGitLog(data.commits);
    } catch {
      // Silently fail
    }
  }

  function renderGitLog(commits) {
    gitLogList.innerHTML = '';
    if (!commits || commits.length === 0) {
      gitLogList.innerHTML = '<div class="git-empty">No commits</div>';
      return;
    }
    for (const c of commits) {
      const row = document.createElement('div');
      row.className = 'git-log-row';

      const hash = document.createElement('span');
      hash.className = 'git-log-hash';
      hash.textContent = c.shortHash;

      const msg = document.createElement('span');
      msg.className = 'git-log-msg';
      msg.textContent = c.message;
      msg.title = c.message;

      const date = document.createElement('span');
      date.className = 'git-log-date';
      date.textContent = relativeTime(c.date);

      row.appendChild(hash);
      row.appendChild(msg);
      row.appendChild(date);
      gitLogList.appendChild(row);
    }
  }

  btnGitLogToggle.onclick = () => {
    gitLogExpanded = !gitLogExpanded;
    const logSection = document.getElementById('git-log-section');
    logSection.classList.toggle('collapsed', !gitLogExpanded);
    btnGitLogToggle.innerHTML = gitLogExpanded ? '&#x25BC;' : '&#x25B6;';
  };

  // --- Right Panel Divider Drag ---

  const divider = document.getElementById('right-panel-divider');
  const shellSection = document.getElementById('shell-section');

  let isDragging = false;
  let rafPending = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging && !isSidebarDragging) return;

    if (isSidebarDragging) {
      if (sidebarRafPending) return;
      sidebarRafPending = true;
      requestAnimationFrame(() => {
        sidebarRafPending = false;
        const newWidth = Math.max(160, Math.min(e.clientX, 500));
        sidebar.style.width = newWidth + 'px';
        sidebar.style.minWidth = newWidth + 'px';
        if (fitAddon) fitAddon.fit();
      });
      return;
    }

    if (rafPending) return; // true single-frame debounce

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const panelRect = rightPanel.getBoundingClientRect();
      const offset = e.clientY - panelRect.top;
      const total = panelRect.height;
      const minHeight = 100;

      if (offset < minHeight || total - offset < minHeight) return;

      const pct = (offset / total) * 100;
      fileTreeSection.style.flex = `0 0 ${pct}%`;

      if (shellFitAddon) shellFitAddon.fit();
    });
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (shellFitAddon) shellFitAddon.fit();
    }
    if (isSidebarDragging) {
      isSidebarDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (fitAddon) fitAddon.fit();
    }
  });

  // --- Sidebar Divider Drag ---

  const sidebar = document.getElementById('sidebar');
  const sidebarDivider = document.getElementById('sidebar-divider');
  let isSidebarDragging = false;
  let sidebarRafPending = false;

  sidebarDivider.addEventListener('mousedown', (e) => {
    isSidebarDragging = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  // --- Mobile drawer toggles ---

  const mobileOverlay = document.getElementById('mobile-overlay');
  const btnMobileSidebar = document.getElementById('btn-mobile-sidebar');
  const btnMobilePanel = document.getElementById('btn-mobile-panel');

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function closeMobileDrawers() {
    sidebar.classList.remove('mobile-open');
    rightPanel.classList.remove('mobile-open');
    mobileOverlay.classList.remove('visible');
    mobileOverlay.classList.add('hidden');
  }

  btnMobileSidebar.onclick = () => {
    const isOpen = sidebar.classList.contains('mobile-open');
    closeMobileDrawers();
    if (!isOpen) {
      sidebar.classList.add('mobile-open');
      mobileOverlay.classList.remove('hidden');
      mobileOverlay.classList.add('visible');
    }
  };

  btnMobilePanel.onclick = () => {
    const isOpen = rightPanel.classList.contains('mobile-open');
    closeMobileDrawers();
    if (!isOpen) {
      rightPanel.classList.add('mobile-open');
      mobileOverlay.classList.remove('hidden');
      mobileOverlay.classList.add('visible');
    }
  };

  mobileOverlay.onclick = closeMobileDrawers;

  // Close drawers on session click (mobile)
  const origAttachSession = attachSession;
  attachSession = function (sessionId) {
    if (isMobile()) closeMobileDrawers();
    origAttachSession(sessionId);
  };

  // Refit terminals on orientation change
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (fitAddon) fitAddon.fit();
      if (shellFitAddon) shellFitAddon.fit();
    }, 200);
  });

  // --- Session controls (status bar buttons) ---

  statusInterrupt.onclick = () => {
    if (!activeSessionId) return;
    wsSend(JSON.stringify({ type: 'input', sessionId: activeSessionId, data: '\x03' }));
    term.focus();
  };

  statusCompact.onclick = () => {
    if (!activeSessionId) return;
    wsSend(JSON.stringify({ type: 'input', sessionId: activeSessionId, data: '/compact\r' }));
    term.focus();
  };

  // --- File tree filter ---

  fileTreeFilter.oninput = debounce(() => {
    const query = fileTreeFilter.value.trim().toLowerCase();
    filterFileTree(fileTreeEl, query);
  }, 150);

  function filterFileTree(container, query) {
    if (!query) {
      // Clear all filter states
      const items = container.querySelectorAll('.file-tree-item');
      items.forEach(el => el.classList.remove('filter-hidden'));
      // Remove highlights
      container.querySelectorAll('.file-tree-highlight').forEach(hl => {
        hl.replaceWith(document.createTextNode(hl.textContent));
      });
      // Collapse all children containers that were force-expanded
      container.querySelectorAll('.file-tree-children.filter-expanded').forEach(ch => {
        ch.classList.remove('filter-expanded');
        if (!expandedDirs.has(ch.parentElement && ch.parentElement.dataset && ch.parentElement.dataset.dirPath)) {
          // Only collapse if not user-expanded
        }
      });
      return;
    }

    const allItems = container.querySelectorAll('.file-tree-item');
    const matchedParents = new Set();

    // First pass: find matching file items and mark them
    allItems.forEach(item => {
      const label = item.querySelector('.file-tree-label');
      if (!label) return;
      const text = label.textContent.toLowerCase();
      const isFolder = item.classList.contains('file-tree-folder');

      if (text.includes(query)) {
        item.classList.remove('filter-hidden');
        // Highlight match
        highlightMatch(label, query);
        // Mark all ancestor folders as visible
        let parent = item.parentElement;
        while (parent && parent !== container) {
          if (parent.classList.contains('file-tree-children')) {
            parent.classList.add('expanded', 'filter-expanded');
            matchedParents.add(parent);
          }
          parent = parent.parentElement;
        }
      } else if (!isFolder) {
        item.classList.add('filter-hidden');
        clearHighlight(label);
      }
    });

    // Second pass: show folders that have visible children, hide empty ones
    allItems.forEach(item => {
      if (!item.classList.contains('file-tree-folder')) return;
      const label = item.querySelector('.file-tree-label');
      const sibling = item.parentElement && item.parentElement.querySelector('.file-tree-children');
      if (sibling && matchedParents.has(sibling)) {
        item.classList.remove('filter-hidden');
      } else if (label && label.textContent.toLowerCase().includes(query)) {
        item.classList.remove('filter-hidden');
      } else {
        item.classList.add('filter-hidden');
      }
      if (label) {
        if (label.textContent.toLowerCase().includes(query)) {
          highlightMatch(label, query);
        } else {
          clearHighlight(label);
        }
      }
    });
  }

  function highlightMatch(label, query) {
    // Remove existing highlights first
    clearHighlight(label);
    const text = label.textContent;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) return;

    const before = document.createTextNode(text.slice(0, idx));
    const match = document.createElement('span');
    match.className = 'file-tree-highlight';
    match.textContent = text.slice(idx, idx + query.length);
    const after = document.createTextNode(text.slice(idx + query.length));

    label.textContent = '';
    label.appendChild(before);
    label.appendChild(match);
    label.appendChild(after);
  }

  function clearHighlight(label) {
    const highlights = label.querySelectorAll('.file-tree-highlight');
    if (highlights.length === 0) return;
    const text = label.textContent;
    label.textContent = text;
  }

  // --- Keyboard shortcuts overlay ---

  function openShortcuts() {
    shortcutsOverlay.classList.remove('hidden');
  }

  function closeShortcuts() {
    shortcutsOverlay.classList.add('hidden');
  }

  document.getElementById('btn-close-shortcuts').onclick = closeShortcuts;

  shortcutsOverlay.onclick = (e) => {
    if (e.target === shortcutsOverlay) closeShortcuts();
  };

  // Extend keyboard handler: ? shows shortcuts, Ctrl+K opens palette, Esc closes
  document.addEventListener('keydown', (e) => {
    // Ctrl+\ — toggle focus mode
    if (e.key === '\\' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleFocusMode();
      return;
    }

    // Ctrl+= / Ctrl+- / Ctrl+0 — font size zoom
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setTermFontSize(termFontSize + 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      setTermFontSize(termFontSize - 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      setTermFontSize(DEFAULT_FONT_SIZE);
      return;
    }

    // Ctrl+K — command palette (works from anywhere)
    if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (cpOverlay.classList.contains('hidden')) {
        openCommandPalette();
      } else {
        closeCommandPalette();
      }
      return;
    }

    // Esc — close overlays
    if (e.key === 'Escape') {
      if (!cpOverlay.classList.contains('hidden')) {
        closeCommandPalette();
        e.stopPropagation();
        return;
      }
      if (!shortcutsOverlay.classList.contains('hidden')) {
        closeShortcuts();
        e.stopPropagation();
        return;
      }
    }

    // Don't trigger shortcuts when typing in inputs or terminals
    const tag = e.target.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const inTerminal = terminalEl.contains(document.activeElement) ||
                       shellTerminalEl.contains(document.activeElement);

    if (e.key === '?' && !inInput && !inTerminal) {
      e.preventDefault();
      openShortcuts();
    }
  });

  // --- Command palette ---

  function openCommandPalette() {
    cpInput.value = '';
    cpSelectedIndex = -1;
    cpOverlay.classList.remove('hidden');
    cpInput.focus();
    renderCommandPaletteResults('');
  }

  function closeCommandPalette() {
    cpOverlay.classList.add('hidden');
  }

  cpOverlay.onclick = (e) => {
    if (e.target === cpOverlay) closeCommandPalette();
  };

  function getCommandPaletteItems(query) {
    const items = [];
    const q = query.toLowerCase();

    // Quick actions (always available)
    const actions = [
      { icon: '\u25B6', label: 'New Project', meta: 'action', action: () => { closeCommandPalette(); openModal(); } },
    ];
    if (activeSessionId) {
      actions.push(
        { icon: '\u2717', label: 'Interrupt Claude', meta: 'Ctrl+C', action: () => { closeCommandPalette(); statusInterrupt.click(); } },
        { icon: '\u21BB', label: 'Compact Context', meta: '/compact', action: () => { closeCommandPalette(); statusCompact.click(); } },
        { icon: '\u21BB', label: 'Refresh File Tree', meta: 'action', action: () => { closeCommandPalette(); renderFileTreeDir(fileTreeEl, '', 0); } },
        { icon: '\u21BB', label: 'Refresh Git Status', meta: 'action', action: () => { closeCommandPalette(); refreshGitStatus(); } },
        { icon: '\u25A3', label: 'Toggle Focus Mode', meta: 'Ctrl+\\', action: () => { closeCommandPalette(); toggleFocusMode(); } },
        { icon: '\u2717', label: 'Close All Tabs', meta: 'action', action: () => { closeCommandPalette(); closeAllTabs(); } },
      );
    }

    // Sessions
    const sessionItems = sessions.map(s => {
      const project = projects.find(p => p.id === s.projectId);
      return {
        icon: s.alive ? '\u25CF' : '\u25CB',
        label: (project ? project.name + ' / ' : '') + (s.name || 'Untitled'),
        meta: s.alive ? 'running' : 'exited',
        action: () => { closeCommandPalette(); attachSession(s.id); },
        group: 'sessions',
      };
    });

    // Files from open tabs
    const fileItems = openTabs.map(t => ({
      icon: '\u2610',
      label: t.filename,
      meta: t.fullPath,
      action: () => { closeCommandPalette(); switchTab(t.id); },
      group: 'files',
    }));

    // Collect file tree entries recursively
    const treeFiles = [];
    function collectTreeFiles(container) {
      const labels = container.querySelectorAll('.file-tree-item:not(.file-tree-folder) .file-tree-label');
      labels.forEach(label => {
        const path = label.title || label.textContent;
        const name = label.textContent;
        treeFiles.push({
          icon: '\u2610',
          label: name,
          meta: path,
          action: () => { closeCommandPalette(); openFileTab(path, name); },
          group: 'files',
        });
      });
    }
    collectTreeFiles(fileTreeEl);

    // Merge file items (open tabs + tree, deduped)
    const seenPaths = new Set(fileItems.map(f => f.meta));
    const allFiles = [...fileItems];
    for (const tf of treeFiles) {
      if (!seenPaths.has(tf.meta)) {
        allFiles.push(tf);
        seenPaths.add(tf.meta);
      }
    }

    // Filter
    const filtered = { actions: [], sessions: [], files: [] };

    for (const a of actions) {
      if (!q || a.label.toLowerCase().includes(q)) {
        filtered.actions.push(a);
      }
    }
    for (const s of sessionItems) {
      if (!q || s.label.toLowerCase().includes(q)) {
        filtered.sessions.push(s);
      }
    }
    for (const f of allFiles) {
      if (!q || f.label.toLowerCase().includes(q) || f.meta.toLowerCase().includes(q)) {
        filtered.files.push(f);
      }
    }

    // Limit files to 15
    filtered.files = filtered.files.slice(0, 15);

    return filtered;
  }

  function renderCommandPaletteResults(query) {
    const filtered = getCommandPaletteItems(query);
    cpResults.innerHTML = '';

    const allItems = [];

    function addGroup(label, items) {
      if (items.length === 0) return;
      const groupLabel = document.createElement('div');
      groupLabel.className = 'cp-group-label';
      groupLabel.textContent = label;
      cpResults.appendChild(groupLabel);

      for (const item of items) {
        const el = document.createElement('div');
        el.className = 'cp-item';
        el.dataset.cpIndex = allItems.length;

        const icon = document.createElement('span');
        icon.className = 'cp-item-icon';
        icon.textContent = item.icon;

        const lbl = document.createElement('span');
        lbl.className = 'cp-item-label';
        // Highlight matching text
        if (query) {
          const idx = item.label.toLowerCase().indexOf(query.toLowerCase());
          if (idx >= 0) {
            lbl.innerHTML = escapeHtml(item.label.slice(0, idx)) +
              '<span class="cp-item-highlight">' + escapeHtml(item.label.slice(idx, idx + query.length)) + '</span>' +
              escapeHtml(item.label.slice(idx + query.length));
          } else {
            lbl.textContent = item.label;
          }
        } else {
          lbl.textContent = item.label;
        }

        const meta = document.createElement('span');
        meta.className = 'cp-item-meta';
        meta.textContent = item.meta;

        el.appendChild(icon);
        el.appendChild(lbl);
        el.appendChild(meta);

        el.onclick = () => item.action();
        el.onmouseenter = () => {
          cpSelectedIndex = parseInt(el.dataset.cpIndex);
          updateCpSelection();
        };

        cpResults.appendChild(el);
        allItems.push({ el, action: item.action });
      }
    }

    addGroup('Actions', filtered.actions);
    addGroup('Sessions', filtered.sessions);
    addGroup('Files', filtered.files);

    if (allItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = 'No results found';
      cpResults.appendChild(empty);
    }

    // Store for keyboard nav
    cpResults._items = allItems;
    cpSelectedIndex = allItems.length > 0 ? 0 : -1;
    updateCpSelection();
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function updateCpSelection() {
    const items = cpResults._items || [];
    items.forEach((item, i) => {
      item.el.classList.toggle('cp-selected', i === cpSelectedIndex);
    });
    // Scroll selected into view
    if (cpSelectedIndex >= 0 && items[cpSelectedIndex]) {
      items[cpSelectedIndex].el.scrollIntoView({ block: 'nearest' });
    }
  }

  cpInput.oninput = () => {
    renderCommandPaletteResults(cpInput.value.trim());
  };

  cpInput.onkeydown = (e) => {
    const items = cpResults._items || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        cpSelectedIndex = (cpSelectedIndex + 1) % items.length;
        updateCpSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        cpSelectedIndex = (cpSelectedIndex - 1 + items.length) % items.length;
        updateCpSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cpSelectedIndex >= 0 && items[cpSelectedIndex]) {
        items[cpSelectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  };

  // --- Scroll-to-bottom button ---

  function updateScrollToBottomBtn() {
    if (!activeSessionId || !term || activeTabId !== 'claude') {
      scrollToBottomBtn.classList.add('hidden');
      return;
    }
    if (isNearBottom(term)) {
      scrollToBottomBtn.classList.add('hidden');
    } else {
      scrollToBottomBtn.classList.remove('hidden');
    }
  }

  scrollToBottomBtn.onclick = () => {
    if (term) {
      term.scrollToBottom();
      claudeSticky = true;
      scrollToBottomBtn.classList.add('hidden');
      term.focus();
    }
  };

  // --- Live sidebar times ---

  function startSidebarTimeUpdates() {
    if (sidebarTimeTimer) return;
    sidebarTimeTimer = setInterval(() => {
      const timeEls = document.querySelectorAll('.session-time');
      timeEls.forEach(el => {
        const li = el.closest('li[data-session-id]');
        if (!li) return;
        const s = sessions.find(sess => sess.id === li.dataset.sessionId);
        if (s) el.textContent = relativeTime(s.createdAt);
      });
    }, 30000);
  }

  // --- Connection status indicator ---

  let wasConnected = false;

  function updateConnectionStatus(connected) {
    if (!statusConnection) return;
    if (connected) {
      statusConnection.innerHTML = '<span class="status-connection-dot connected"></span> Connected';
      // Show reconnect toast only if we were previously connected (not initial)
      if (wasConnected === false && wasConnected !== undefined) {
        // wasConnected starts as false; skip the very first connect
      }
      if (wasConnected === 'disconnected') {
        showToast('Connection restored', 'success', 3000);
      }
      wasConnected = true;
    } else {
      statusConnection.innerHTML = '<span class="status-connection-dot disconnected"></span> Reconnecting\u2026';
      if (wasConnected === true) {
        showToast('Connection lost \u2014 reconnecting\u2026', 'warning', 5000);
      }
      wasConnected = 'disconnected';
    }
  }

  // --- Restart button ---

  statusRestart.onclick = async () => {
    if (!activeSessionId) return;
    statusRestart.disabled = true;
    statusRestart.textContent = 'Restarting\u2026';
    await restartSession(activeSessionId);
    statusRestart.disabled = false;
    statusRestart.textContent = 'Restart';
  };

  // --- Session info popover ---

  statusCopyCli.onclick = (e) => {
    e.stopPropagation();
    toggleSessionInfoPopover();
  };

  function toggleSessionInfoPopover() {
    const existing = document.getElementById('session-info-popover');
    if (existing) { existing.remove(); return; }

    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    const project = projects.find(p => p.id === session.projectId);

    const popover = document.createElement('div');
    popover.id = 'session-info-popover';
    popover.className = 'session-info-popover';

    const resumeId = session.claudeSessionId;
    const cliCmd = session.provider === 'codex'
      ? (resumeId ? `codex --resume ${resumeId}` : 'codex')
      : (resumeId ? `claude --resume ${resumeId}` : 'claude');
    const fullCmd = project ? `${cliCmd} --cwd ${project.cwd}` : cliCmd;

    const rows = [
      { label: 'Session', value: session.name || 'Untitled' },
      { label: 'Project', value: project ? project.name : 'Unknown' },
      { label: 'Branch', value: session.branchName || 'none' },
      { label: 'Worktree', value: session.worktreePath || 'N/A' },
      { label: 'Created', value: new Date(session.createdAt).toLocaleString() },
      { label: 'Status', value: session.alive !== false ? 'Running' : 'Exited' },
    ];

    let html = '<div class="sip-rows">';
    for (const r of rows) {
      html += `<div class="sip-row"><span class="sip-label">${r.label}</span><span class="sip-value">${escapeHtml(r.value)}</span></div>`;
    }
    html += '</div>';
    html += `<div class="sip-cli"><code>${escapeHtml(fullCmd)}</code></div>`;
    html += '<div class="sip-actions"><button class="sip-btn" id="sip-copy-cmd">Copy CLI Command</button></div>';

    popover.innerHTML = html;
    document.body.appendChild(popover);

    // Position above the CLI button
    const btnRect = statusCopyCli.getBoundingClientRect();
    popover.style.bottom = (window.innerHeight - btnRect.top + 4) + 'px';
    popover.style.right = (window.innerWidth - btnRect.right) + 'px';

    document.getElementById('sip-copy-cmd').onclick = () => {
      navigator.clipboard.writeText(fullCmd).then(
        () => showToast('CLI command copied', 'info', 2000),
        () => showToast('Failed to copy', 'error', 2000)
      );
    };

    // Close on click outside
    const close = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== statusCopyCli) {
        popover.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  // --- Status bar changes indicator ---

  function updateStatusChangesCount(data) {
    if (!statusChanges) return;
    const total = (data.staged ? data.staged.length : 0) +
      (data.unstaged ? data.unstaged.length : 0) +
      (data.untracked ? data.untracked.length : 0);
    if (total > 0) {
      statusChanges.classList.remove('hidden');
      statusChanges.innerHTML =
        `<span class="status-changes-icon">\u25CF</span> ${total} change${total === 1 ? '' : 's'}`;
    } else {
      statusChanges.classList.add('hidden');
      statusChanges.textContent = '';
    }
  }

  if (statusChanges) {
    statusChanges.onclick = () => {
      // Switch to Git tab in the right panel
      const gitTab = rightPanelTabs.querySelector('[data-rp-tab="git"]');
      if (gitTab) gitTab.click();
    };
  }

  // --- Git tab notification badge ---

  function setGitTabBadge(show) {
    gitChangesPending = show;
    const gitTab = rightPanelTabs.querySelector('[data-rp-tab="git"]');
    if (!gitTab) return;
    const existing = gitTab.querySelector('.rp-tab-badge');
    if (show && !existing) {
      const badge = document.createElement('span');
      badge.className = 'rp-tab-badge';
      gitTab.appendChild(badge);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  // --- Terminal font size zoom ---

  function updateFontSizeDisplay() {
    if (statusFontSize) {
      statusFontSize.textContent = `${termFontSize}px`;
    }
  }

  if (statusFontSize) {
    statusFontSize.onclick = () => setTermFontSize(DEFAULT_FONT_SIZE);
  }

  function setTermFontSize(size) {
    termFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
    if (term) {
      term.options.fontSize = termFontSize;
      if (fitAddon) fitAddon.fit();
    }
    if (shellTerm) {
      shellTerm.options.fontSize = termFontSize;
      if (shellFitAddon) shellFitAddon.fit();
    }
    updateFontSizeDisplay();
  }

  // --- Focus mode ---

  function toggleFocusMode() {
    focusModeActive = !focusModeActive;
    sidebar.classList.toggle('focus-hidden', focusModeActive);
    sidebarDivider.classList.toggle('focus-hidden', focusModeActive);
    if (focusModeActive) {
      rightPanel.classList.add('focus-hidden');
    } else {
      rightPanel.classList.remove('focus-hidden');
    }
    // Refit terminal after layout change
    requestAnimationFrame(() => {
      if (fitAddon) fitAddon.fit();
      if (shellFitAddon) shellFitAddon.fit();
    });
    if (focusModeActive) {
      showToast('Focus mode on \u2014 press Ctrl+\\ to exit', 'info', 2000);
    }
  }

  // --- Breadcrumb rename on double-click ---

  breadcrumbSession.ondblclick = () => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;

    const currentName = session.name || 'Untitled';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'breadcrumb-rename-input';

    breadcrumbSession.textContent = '';
    breadcrumbSession.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          const res = await fetch(`/api/sessions/${activeSessionId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
          if (res.ok) {
            session.name = newName;
            renderSidebar();
          }
        } catch { /* ignore */ }
      }
      breadcrumbSession.textContent = session.name || 'Untitled';
    };

    input.onblur = commit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        committed = true;
        breadcrumbSession.textContent = currentName;
      }
    };
  };

  // --- Sidebar filter ---

  sidebarFilter.oninput = debounce(() => {
    filterSidebar(sidebarFilter.value.trim().toLowerCase());
  }, 150);

  function filterSidebar(query) {
    const groups = projectListEl.querySelectorAll('.project-group');
    groups.forEach(group => {
      const sessionItems = group.querySelectorAll('.project-sessions li[data-session-id]');
      let visibleCount = 0;

      sessionItems.forEach(li => {
        const nameEl = li.querySelector('.session-name');
        const branchEl = li.querySelector('.branch-badge');
        const name = nameEl ? nameEl.textContent.toLowerCase() : '';
        const branch = branchEl ? branchEl.textContent.toLowerCase() : '';
        if (!query || name.includes(query) || branch.includes(query)) {
          li.style.display = '';
          visibleCount++;
        } else {
          li.style.display = 'none';
        }
      });

      // Auto-expand project groups that have matches when filtering
      if (query && visibleCount > 0) {
        const ul = group.querySelector('.project-sessions');
        if (ul && !ul.classList.contains('expanded')) {
          ul.classList.add('expanded', 'filter-expanded');
          const arrow = group.querySelector('.project-arrow');
          if (arrow) arrow.classList.add('expanded');
        }
      }

      // Hide project groups with no matching sessions (only when filtering)
      if (query && visibleCount === 0) {
        group.style.display = 'none';
      } else {
        group.style.display = '';
      }
    });

    // Restore state when filter is cleared
    if (!query) {
      groups.forEach(group => {
        const ul = group.querySelector('.project-sessions');
        if (ul && ul.classList.contains('filter-expanded')) {
          ul.classList.remove('filter-expanded', 'expanded');
          const arrow = group.querySelector('.project-arrow');
          if (arrow) arrow.classList.remove('expanded');
        }
        group.querySelectorAll('.project-sessions li[data-session-id]').forEach(li => {
          li.style.display = '';
        });
      });
    }
  }

  // --- Init ---
  initTerminal();
  initShellTerminal();
  startSidebarTimeUpdates();
  updateFontSizeDisplay();
  connect();
})();
