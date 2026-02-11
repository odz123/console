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
  const tabScrollLeft = document.getElementById('tab-scroll-left');
  const tabScrollRight = document.getElementById('tab-scroll-right');
  const fileViewer = document.getElementById('file-viewer');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const fileViewerRefresh = document.getElementById('file-viewer-refresh');
  const fileViewerWrap = document.getElementById('file-viewer-wrap');
  const fileViewerCopy = document.getElementById('file-viewer-copy');
  const fileViewerSplit = document.getElementById('file-viewer-split');
  const fileViewerEdit = document.getElementById('file-viewer-edit');
  const fileViewerSave = document.getElementById('file-viewer-save');
  const fileViewerCancelEdit = document.getElementById('file-viewer-cancel-edit');
  const fileViewerContent = document.getElementById('file-viewer-content');
  let fileViewerWordWrap = false;
  let fileViewerEditing = false;
  let diffSplitMode = false;

  // File viewer search refs
  const fvSearchBar = document.getElementById('fv-search-bar');
  const fvSearchInput = document.getElementById('fv-search-input');
  const fvSearchCount = document.getElementById('fv-search-count');
  const fvSearchPrev = document.getElementById('fv-search-prev');
  const fvSearchNext = document.getElementById('fv-search-next');
  const fvSearchClose = document.getElementById('fv-search-close');
  let fvSearchMatches = [];
  let fvSearchCurrentIdx = -1;

  // Find and Replace refs
  const fvReplaceRow = document.getElementById('fv-replace-row');
  const fvReplaceInput = document.getElementById('fv-replace-input');
  const fvReplaceOne = document.getElementById('fv-replace-one');
  const fvReplaceAll = document.getElementById('fv-replace-all');
  const fvToggleReplace = document.getElementById('fv-search-toggle-replace');

  // Quick file open refs
  const quickOpenOverlay = document.getElementById('quick-open-overlay');
  const quickOpenInput = document.getElementById('quick-open-input');
  const quickOpenResults = document.getElementById('quick-open-results');

  // File preview tooltip ref
  const filePreviewTooltip = document.getElementById('file-preview-tooltip');

  // Status bar cursor/file info refs
  const statusCursorPos = document.getElementById('status-cursor-pos');
  const statusFileInfo = document.getElementById('status-file-info');

  // Go to Symbol refs
  const symbolOverlay = document.getElementById('symbol-overlay');
  const symbolInput = document.getElementById('symbol-input');
  const symbolResults = document.getElementById('symbol-results');

  // Minimap refs
  const fvMinimap = document.getElementById('fv-minimap');
  const fvMinimapCanvas = document.getElementById('fv-minimap-canvas');
  const fvMinimapSlider = document.getElementById('fv-minimap-slider');

  // Sticky scroll header ref
  const fvStickyHeader = document.getElementById('fv-sticky-header');

  // Diff navigation refs
  const fvDiffPrev = document.getElementById('fv-diff-prev');
  const fvDiffNext = document.getElementById('fv-diff-next');

  // Session search refs
  const sessionSearchOverlay = document.getElementById('session-search-overlay');
  const sessionSearchInput = document.getElementById('session-search-input');
  const sessionSearchResults = document.getElementById('session-search-results');

  // Bookmark button refs
  const fvBookmarkToggle = document.getElementById('fv-bookmark-toggle');
  const fvBookmarkPrev = document.getElementById('fv-bookmark-prev');
  const fvBookmarkNext = document.getElementById('fv-bookmark-next');

  // Tab preview tooltip ref
  const tabPreviewTooltip = document.getElementById('tab-preview-tooltip');

  // Auto-save refs
  const autosaveToast = document.getElementById('autosave-toast');
  const autosaveUndo = document.getElementById('autosave-undo');

  // Command history panel refs
  const cmdHistoryPanel = document.getElementById('cmd-history-panel');
  const cmdHistoryList = document.getElementById('cmd-history-list');
  const btnCmdHistoryClear = document.getElementById('btn-cmd-history-clear');

  // Selection info status bar ref
  const statusSelectionInfo = document.getElementById('status-selection-info');

  // Zen mode button
  const statusZen = document.getElementById('status-zen');

  // Problems panel refs
  const statusProblems = document.getElementById('status-problems');
  const problemsPanel = document.getElementById('problems-panel');
  const problemsList = document.getElementById('problems-list');
  const problemsCount = document.getElementById('problems-count');
  const problemsPanelClose = document.getElementById('problems-panel-close');

  // Breadcrumb dropdown ref
  const breadcrumbDropdown = document.getElementById('breadcrumb-dropdown');

  // Split editor refs
  const splitEditorOverlay = document.getElementById('split-editor-overlay');
  const splitLeftContent = document.getElementById('split-left-content');
  const splitRightContent = document.getElementById('split-right-content');
  const splitLeftFilename = document.getElementById('split-left-filename');
  const splitRightFilename = document.getElementById('split-right-filename');
  const splitLeftClose = document.getElementById('split-left-close');
  const splitRightClose = document.getElementById('split-right-close');
  const splitEditorDivider = document.getElementById('split-editor-divider');
  const fvSplitViewBtn = document.getElementById('fv-split-view');

  // Outline panel ref
  const outlinePanel = document.getElementById('outline-panel');
  const outlineList = document.getElementById('outline-list');

  // Token count ref
  const promptTokenCount = document.getElementById('prompt-token-count');

  // File comparison refs
  const fileCompareOverlay = document.getElementById('file-compare-overlay');
  const fileCompareInput = document.getElementById('file-compare-input');
  const fileCompareResults = document.getElementById('file-compare-results');

  // Go to definition tooltip
  const gotoDefTooltip = document.getElementById('goto-def-tooltip');

  // File tree header button refs
  const btnExpandAll = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');
  const btnToggleFileTree = document.getElementById('btn-toggle-file-tree');
  const btnRefreshFileTree = document.getElementById('btn-refresh-file-tree');
  const fileTreeSection = document.getElementById('file-tree-section');

  // Recent files tracking
  let recentFiles = [];
  const MAX_RECENT_FILES = 20;
  try {
    const saved = localStorage.getItem('claude-console-recent-files');
    if (saved) recentFiles = JSON.parse(saved);
  } catch {}

  // Session color labels
  let sessionColors = {};
  try {
    const saved = localStorage.getItem('claude-console-session-colors');
    if (saved) sessionColors = JSON.parse(saved);
  } catch {}

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

  // New feature refs
  const statusNotify = document.getElementById('status-notify');
  const statusTheme = document.getElementById('status-theme');
  const statusExport = document.getElementById('status-export');
  const promptBar = document.getElementById('prompt-bar');
  const promptInput = document.getElementById('prompt-input');
  const promptSend = document.getElementById('prompt-send');

  // Stop button ref
  const stopBtn = document.getElementById('stop-btn');

  // Quick actions ref
  const quickActionsMenu = document.getElementById('quick-actions');

  // Terminal search refs
  const termSearchBar = document.getElementById('term-search-bar');
  const termSearchInput = document.getElementById('term-search-input');
  const termSearchCount = document.getElementById('term-search-count');
  const termSearchPrev = document.getElementById('term-search-prev');
  const termSearchNext = document.getElementById('term-search-next');
  const termSearchClose = document.getElementById('term-search-close');
  let termSearchAddon = null;

  // File autocomplete refs
  const fileAutocomplete = document.getElementById('file-autocomplete');
  const promptFileChips = document.getElementById('prompt-file-chips');

  // Dirty tabs tracking (unsaved edits)
  const dirtyTabs = new Set();

  // Line bookmarks: Map<tabId, Set<lineNum>>
  const bookmarks = new Map();

  // Command history for panel
  const commandHistory = [];

  // Auto-save state
  let autoSaveTimer = null;
  let autoSaveLastContent = null;
  const AUTO_SAVE_DELAY = 3000;

  // Tab file change tracking: Map<tabId, originalContent>
  const tabOriginalContent = new Map();

  // Terminal annotation patterns (errors/warnings from terminal)
  const termAnnotations = new Map(); // Map<filePath, [{line, type, message}]>

  // Attached files state for prompt bar
  let attachedFiles = [];

  // Prompt history state
  const promptHistory = [];
  let promptHistoryIdx = -1;
  let promptHistoryDraft = '';
  const MAX_PROMPT_HISTORY = 50;

  // Git diff preview ref
  const gitDiffPreview = document.getElementById('git-diff-preview');
  const btnGitPreview = document.getElementById('btn-git-preview');

  // Scroll line count ref
  const scrollLineCount = document.getElementById('scroll-line-count');

  // Session pinning state
  let pinnedSessions = new Set();
  try {
    const saved = localStorage.getItem('claude-console-pinned-sessions');
    if (saved) pinnedSessions = new Set(JSON.parse(saved));
  } catch {}

  // Notification dot state
  let gitChangesPending = false;

  // Progress bar ref
  const progressBar = document.getElementById('progress-bar');

  // Focus mode state
  let focusModeActive = false;
  let zenModeActive = false;

  // Mini sidebar state
  let sidebarCollapsed = false;
  const sidebar = document.getElementById('sidebar');
  const sidebarDivider = document.getElementById('sidebar-divider');

  // Sidebar filter ref
  const sidebarFilter = document.getElementById('sidebar-filter');

  // Git status cache for file tree change indicators
  let gitFileStatusMap = new Map(); // filePath -> status letter (M, A, D, ?, etc.)

  // Browser notifications state
  let notificationsEnabled = false;
  let notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';

  // Theme state
  let currentTheme = 'dark';
  try {
    const saved = localStorage.getItem('claude-console-theme');
    if (saved === 'light') currentTheme = 'light';
  } catch {}
  if (currentTheme === 'light') document.body.classList.add('light-theme');

  // Check/restore notification preference
  try {
    notificationsEnabled = localStorage.getItem('claude-console-notifications') === 'true';
  } catch {}

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

  // --- Browser notifications ---
  function requestNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      notificationsEnabled = true;
      try { localStorage.setItem('claude-console-notifications', 'true'); } catch {}
      return;
    }
    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        notificationPermission = permission;
        notificationsEnabled = permission === 'granted';
        try { localStorage.setItem('claude-console-notifications', String(notificationsEnabled)); } catch {}
      });
    }
  }

  function sendBrowserNotification(title, body) {
    if (!notificationsEnabled || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (document.hasFocus()) return; // Don't notify if tab is focused
    try {
      const n = new Notification(title, {
        body,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">✦</text></svg>',
        tag: 'claude-console-idle',
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 8000);
    } catch {}
  }

  function toggleNotifications() {
    if (!notificationsEnabled) {
      requestNotificationPermission();
    } else {
      notificationsEnabled = false;
      try { localStorage.setItem('claude-console-notifications', 'false'); } catch {}
    }
  }

  // --- Theme toggle ---
  function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.body.classList.toggle('light-theme', currentTheme === 'light');
    try { localStorage.setItem('claude-console-theme', currentTheme); } catch {}

    // Update terminal themes
    const lightTermTheme = {
      background: '#f5f2ee',
      foreground: '#3d3a36',
      cursor: '#d97757',
      cursorAccent: '#f5f2ee',
      selectionBackground: '#d9d1c7',
      black: '#3d3a36',
      red: '#c94040',
      green: '#5a8f4a',
      yellow: '#a88f40',
      blue: '#4a7fa0',
      magenta: '#a05a7a',
      cyan: '#5a9a8a',
      white: '#f5f2ee',
      brightBlack: '#8c8478',
      brightRed: '#d95555',
      brightGreen: '#6aa05a',
      brightYellow: '#b89f50',
      brightBlue: '#5a8fb0',
      brightMagenta: '#b06a8a',
      brightCyan: '#6aaa9a',
      brightWhite: '#2b2a27',
    };
    const darkTermTheme = {
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
    };
    const newTheme = currentTheme === 'light' ? lightTermTheme : darkTermTheme;
    if (term) term.options.theme = newTheme;
    if (shellTerm) shellTerm.options.theme = newTheme;
  }

  // --- Session output export ---
  function exportSessionOutput() {
    if (!term || !activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    const name = session ? session.name : 'session';

    // Extract text from terminal buffer
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i <= buf.length - 1; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_output.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Session output exported', 'success', 2000);
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

    // Show/hide progress bar
    if (progressBar) {
      progressBar.classList.toggle('hidden', dotClass !== 'working');
    }

    // Show/hide stop button overlay
    if (stopBtn) {
      stopBtn.classList.toggle('hidden', dotClass !== 'working' || activeTabId !== 'claude');
    }

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

    // Update notify button state
    if (statusNotify) {
      statusNotify.classList.toggle('status-btn-active', notificationsEnabled);
      statusNotify.title = notificationsEnabled ? 'Notifications on — click to disable' : 'Enable browser notifications';
    }

    // Update theme button label
    if (statusTheme) {
      statusTheme.textContent = currentTheme === 'dark' ? 'Light' : 'Dark';
    }

    // Show prompt bar when session is active and on Claude tab
    if (promptBar) {
      if (activeTabId === 'claude' && alive) {
        promptBar.classList.remove('hidden');
      } else {
        promptBar.classList.add('hidden');
      }
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
  function showConfirmDialog(title, message, onConfirm, onCancel, confirmText) {
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
    confirmBtn.textContent = confirmText || 'Delete Anyway';
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
            // Parse terminal output for error/warning annotations
            parseTermAnnotations(msg.data);
            updateProblemsCount();
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
            // Auto-refresh open file tabs
            refreshOpenFileTabs();
            // Browser notification
            const idleSession = sessions.find(s => s.id === sessionId);
            sendBrowserNotification(
              'Claude finished',
              idleSession ? `Session "${idleSession.name}" is now idle` : 'Session is now idle'
            );
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
      // Initial for mini sidebar
      header.dataset.initial = (proj.name || 'P').charAt(0).toUpperCase();

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
        // In mini mode, expand sidebar first
        if (sidebarCollapsed) {
          toggleMiniSidebar();
          expandedProjects.add(proj.id);
          renderSidebar();
          return;
        }
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
        .sort((a, b) => {
          // Pinned sessions first, then by creation date
          const aPinned = pinnedSessions.has(a.id) ? 0 : 1;
          const bPinned = pinnedSessions.has(b.id) ? 0 : 1;
          if (aPinned !== bPinned) return aPinned - bPinned;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

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

        // Color label indicator
        if (sessionColors[s.id]) {
          const colorDot = document.createElement('span');
          colorDot.className = 'session-color-dot';
          colorDot.style.background = sessionColors[s.id];
          li.appendChild(colorDot);
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

        // Pin button
        const sPin = document.createElement('button');
        sPin.className = 'session-pin' + (pinnedSessions.has(s.id) ? ' pinned' : '');
        sPin.textContent = pinnedSessions.has(s.id) ? '\u2605' : '\u2606'; // ★ or ☆
        sPin.title = pinnedSessions.has(s.id) ? 'Unpin session' : 'Pin session';
        sPin.onclick = (e) => {
          e.stopPropagation();
          togglePinSession(s.id);
        };
        actions.appendChild(sPin);

        // Clone button
        const sClone = document.createElement('button');
        sClone.className = 'session-clone';
        sClone.textContent = '\u2398'; // Clone icon
        sClone.title = 'Clone session';
        sClone.onclick = (e) => {
          e.stopPropagation();
          cloneSession(s.id);
        };
        actions.appendChild(sClone);

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

        li.oncontextmenu = (e) => showSessionContextMenu(e, s);

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
      // Make file tree items draggable to prompt bar
      row.draggable = true;
      row.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', filePath);
        e.dataTransfer.effectAllowed = 'copy';
      };
      // File preview on hover
      setupFilePreviewHover(row, filePath);
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

        // Dirty indicator (unsaved edits)
        if (dirtyTabs.has(tab.id)) {
          const dirty = document.createElement('span');
          dirty.className = 'tab-dirty';
          dirty.textContent = '\u25CF'; // ●
          dirty.title = 'Unsaved changes';
          el.appendChild(dirty);
        }

        // File change indicator (content changed since open)
        if (tabOriginalContent.has(tab.id) && tab.content !== tabOriginalContent.get(tab.id)) {
          const changed = document.createElement('span');
          changed.className = 'tab-changed';
          changed.textContent = 'M';
          changed.title = 'File modified since opened';
          el.appendChild(changed);
        }
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

      // Tab preview tooltip on hover
      let tabHoverTimer = null;
      el.onmouseenter = () => {
        tabHoverTimer = setTimeout(() => showTabPreview(tab, el), 600);
      };
      el.onmouseleave = () => {
        clearTimeout(tabHoverTimer);
        hideTabPreview();
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

    // Update tab scroll arrows after render
    requestAnimationFrame(updateTabScrollButtons);
  }

  function updateTabScrollButtons() {
    if (!tabScrollLeft || !tabScrollRight) return;
    const overflow = tabList.scrollWidth > tabList.clientWidth;
    if (!overflow) {
      tabScrollLeft.classList.add('hidden');
      tabScrollRight.classList.add('hidden');
      return;
    }
    tabScrollLeft.classList.toggle('hidden', tabList.scrollLeft <= 0);
    tabScrollRight.classList.toggle('hidden',
      tabList.scrollLeft + tabList.clientWidth >= tabList.scrollWidth - 1);
  }

  tabScrollLeft.onclick = () => {
    tabList.scrollBy({ left: -120, behavior: 'smooth' });
    setTimeout(updateTabScrollButtons, 300);
  };
  tabScrollRight.onclick = () => {
    tabList.scrollBy({ left: 120, behavior: 'smooth' });
    setTimeout(updateTabScrollButtons, 300);
  };
  tabList.addEventListener('scroll', debounce(updateTabScrollButtons, 100));

  function getTopInset() {
    const tabH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tab-bar-height')) || 32;
    const bcH = breadcrumbBar && !breadcrumbBar.classList.contains('hidden')
      ? breadcrumbBar.offsetHeight : 0;
    return (tabH + bcH) + 'px';
  }

  function getBottomInset() {
    const statusH = statusBar && !statusBar.classList.contains('hidden') ? 24 : 0;
    const promptH = promptBar && !promptBar.classList.contains('hidden') ? promptBar.offsetHeight : 0;
    return (statusH + promptH) + 'px';
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
      fileViewer.classList.add('hidden');
      // Show prompt bar for Claude tab
      if (promptBar) {
        const session = sessions.find(s => s.id === activeSessionId);
        if (session && session.alive !== false) {
          promptBar.classList.remove('hidden');
        } else {
          promptBar.classList.add('hidden');
        }
      }
      // Show stop button if Claude is working
      if (stopBtn) {
        const idle = sessionIdleState.get(activeSessionId);
        const session = sessions.find(s => s.id === activeSessionId);
        stopBtn.classList.toggle('hidden', !(session && session.alive !== false && idle === false));
      }
      termWrapper.style.inset = `${getTopInset()} 0 ${getBottomInset()} 0`;
      updateScrollToBottomBtn();
      // Hide file-specific status bar items for Claude tab
      if (statusCursorPos) statusCursorPos.classList.add('hidden');
      if (statusFileInfo) statusFileInfo.classList.add('hidden');
      if (statusSelectionInfo) statusSelectionInfo.classList.add('hidden');
      term.focus();
      // Refit terminal synchronously so term.cols/rows are correct before
      // attachSession() sends the attach message with dimensions.
      // Reading clientWidth/clientHeight forces a reflow after the inset change.
      if (fitAddon) fitAddon.fit();
    } else {
      // Show file viewer, hide terminal, hide prompt bar, hide stop button
      termWrapper.style.display = 'none';
      fileViewer.classList.remove('hidden');
      if (promptBar) promptBar.classList.add('hidden');
      if (stopBtn) stopBtn.classList.add('hidden');
      closeTermSearch();
      fileViewer.style.inset = `${getTopInset()} 0 ${getBottomInset()} 0`;
      scrollToBottomBtn.classList.add('hidden');

      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        renderFileContent(tab);
        updateFileInfo(tab);
      }
      // Show cursor pos for file tabs
      if (statusCursorPos) statusCursorPos.classList.remove('hidden');
    }
  }

  function closeTab(tabId, force) {
    const tab = openTabs.find(t => t.id === tabId);
    if (tab && tab.pinned) return; // can't close pinned tabs
    // Check for unsaved edits
    if (!force && dirtyTabs.has(tabId)) {
      showConfirmDialog(
        'Unsaved Changes',
        `"${tab ? tab.filename : 'File'}" has unsaved changes. Close anyway?`,
        () => {
          dirtyTabs.delete(tabId);
          closeTab(tabId, true);
        },
        null,
        'Close Anyway'
      );
      return;
    }
    dirtyTabs.delete(tabId);
    stopWatchingFile(tabId);
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
      { label: 'Open in Split View', action: () => openSplitView(tab) },
      { label: 'Compare with\u2026', action: () => openFileCompare(tab) },
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

    if (contentType.startsWith('image/')) {
      // Image file — create blob URL for preview
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      tab = { id: filePath, filename, fullPath: filePath, content: blobUrl, type: 'image', mimeType: contentType };
    } else if (contentType.includes('application/json')) {
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
      // Track original content for change indicator
      if (tab.content && typeof tab.content === 'string') {
        tabOriginalContent.set(tab.id, tab.content);
      }
      switchTab(tab.id);
      // Track in recent files
      trackRecentFile(tab.fullPath);
      // Start watching for external changes
      if (tab.type === 'text' || tab.type === 'markdown') {
        startWatchingFile(tab.id, tab.fullPath);
      }
    }
  }

  // --- Auto-refresh open file tabs ---
  async function refreshOpenFileTabs() {
    if (!activeSessionId || openTabs.length === 0) return;
    for (const tab of openTabs) {
      if (tab.type === 'binary' || tab.type === 'diff') continue;
      try {
        const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}`);
        if (!res.ok) continue;
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) continue; // binary
        const newContent = await res.text();
        if (newContent !== tab.content) {
          tab.content = newContent;
          // Re-render if this tab is currently visible
          if (activeTabId === tab.id) renderFileContent(tab);
        }
      } catch { /* silently skip */ }
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
        // Clicking a directory segment shows dropdown of sibling files
        const dirPath = parts.slice(0, i + 1).join('/');
        segment.classList.add('fv-path-clickable');
        segment.onclick = (e) => {
          e.stopPropagation();
          showBreadcrumbDropdown(dirPath, segment);
        };
      }
      fileViewerPath.appendChild(segment);
    }
  }

  function renderUnifiedDiff(content) {
    fileViewerContent.className = 'diff-view';
    const lines = content.split('\n');
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
  }

  function renderSplitDiff(content) {
    fileViewerContent.className = 'diff-view diff-split';
    const lines = content.split('\n');
    const leftCol = document.createElement('div');
    leftCol.className = 'diff-split-col diff-split-left';
    const rightCol = document.createElement('div');
    rightCol.className = 'diff-split-col diff-split-right';

    for (const line of lines) {
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        const lEl = document.createElement('div');
        lEl.className = 'diff-line diff-header';
        lEl.textContent = line;
        leftCol.appendChild(lEl);
        const rEl = document.createElement('div');
        rEl.className = 'diff-line diff-header';
        rEl.textContent = line;
        rightCol.appendChild(rEl);
      } else if (line.startsWith('@@')) {
        const lEl = document.createElement('div');
        lEl.className = 'diff-line diff-hunk';
        lEl.textContent = line;
        leftCol.appendChild(lEl);
        const rEl = document.createElement('div');
        rEl.className = 'diff-line diff-hunk';
        rEl.textContent = line;
        rightCol.appendChild(rEl);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const lEl = document.createElement('div');
        lEl.className = 'diff-line diff-del';
        lEl.textContent = line.slice(1);
        leftCol.appendChild(lEl);
        const rEl = document.createElement('div');
        rEl.className = 'diff-line diff-empty';
        rEl.textContent = '\u00A0';
        rightCol.appendChild(rEl);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        const lEl = document.createElement('div');
        lEl.className = 'diff-line diff-empty';
        lEl.textContent = '\u00A0';
        leftCol.appendChild(lEl);
        const rEl = document.createElement('div');
        rEl.className = 'diff-line diff-add';
        rEl.textContent = line.slice(1);
        rightCol.appendChild(rEl);
      } else {
        const text = line.startsWith(' ') ? line.slice(1) : line;
        const lEl = document.createElement('div');
        lEl.className = 'diff-line';
        lEl.textContent = text;
        leftCol.appendChild(lEl);
        const rEl = document.createElement('div');
        rEl.className = 'diff-line';
        rEl.textContent = text;
        rightCol.appendChild(rEl);
      }
    }

    fileViewerContent.appendChild(leftCol);
    fileViewerContent.appendChild(rightCol);
  }

  // Split diff toggle
  fileViewerSplit.onclick = () => {
    diffSplitMode = !diffSplitMode;
    fileViewerSplit.classList.toggle('fv-btn-active', diffSplitMode);
    const tab = openTabs.find(t => t.id === activeTabId);
    if (tab && tab.type === 'diff') {
      fileViewerContent.innerHTML = '';
      if (diffSplitMode) {
        renderSplitDiff(tab.content);
      } else {
        renderUnifiedDiff(tab.content);
      }
    }
  };

  function renderFileContent(tab) {
    renderFileViewerBreadcrumb(tab.fullPath);
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = '';
    // Hide minimap and sticky header by default (shown for plain text)
    if (fvMinimap) fvMinimap.classList.add('hidden');
    if (fvStickyHeader) fvStickyHeader.classList.add('hidden');

    if (tab.type === 'image') {
      fileViewerContent.className = 'image-preview';
      const img = document.createElement('img');
      img.src = tab.content;
      img.alt = tab.filename;
      img.className = 'image-preview-img';
      img.draggable = false;
      fileViewerContent.appendChild(img);

      // Image info bar
      img.onload = () => {
        const info = document.createElement('div');
        info.className = 'image-info';
        info.textContent = `${img.naturalWidth} \u00D7 ${img.naturalHeight}`;
        fileViewerContent.appendChild(info);
      };
      return;
    }

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
      fileViewerSplit.classList.remove('hidden');
      if (fvDiffPrev) fvDiffPrev.classList.remove('hidden');
      if (fvDiffNext) fvDiffNext.classList.remove('hidden');
      if (diffSplitMode) {
        renderSplitDiff(tab.content);
      } else {
        renderUnifiedDiff(tab.content);
      }
      return;
    }
    fileViewerSplit.classList.add('hidden');
    if (fvDiffPrev) fvDiffPrev.classList.add('hidden');
    if (fvDiffNext) fvDiffNext.classList.add('hidden');

    // Plain text with line numbers
    fileViewerContent.className = 'plain-text';
    const lines = tab.content.split('\n');
    const table = document.createElement('div');
    table.className = 'line-table';

    // Pre-compute foldable regions
    const foldRegions = computeFoldRegions(lines);

    for (let i = 0; i < lines.length; i++) {
      const row = document.createElement('div');
      row.className = 'line-row';
      row.dataset.lineNum = i + 1;
      const num = document.createElement('span');
      num.className = 'line-num';
      num.textContent = i + 1;
      num.onclick = (e) => handleLineClick(row, i + 1, e);

      // Add fold toggle if this line starts a foldable region
      const foldRegion = foldRegions.find(r => r.start === i);
      if (foldRegion) {
        const foldBtn = document.createElement('span');
        foldBtn.className = 'fold-toggle';
        foldBtn.textContent = '\u25BC';
        foldBtn.title = `Fold lines ${i + 1}-${foldRegion.end + 1}`;
        foldBtn.onclick = (e) => {
          e.stopPropagation();
          toggleFold(foldRegion, table, foldBtn);
        };
        num.appendChild(foldBtn);
      }

      const text = document.createElement('span');
      text.className = 'line-text';
      // Add indent guides
      const lineContent = lines[i];
      const indentMatch = lineContent.match(/^(\s+)/);
      if (indentMatch) {
        const indentStr = indentMatch[1];
        const tabSize = 2;
        const indentLen = indentStr.replace(/\t/g, ' '.repeat(tabSize)).length;
        const guideCount = Math.floor(indentLen / tabSize);
        for (let g = 0; g < guideCount; g++) {
          const guide = document.createElement('span');
          guide.className = 'indent-guide';
          guide.style.left = (g * tabSize * 0.6) + 'em';
          text.appendChild(guide);
        }
      }
      // Render text with clickable URLs
      renderLineTextWithLinks(text, lineContent);
      // Double-click to highlight all matching words
      text.addEventListener('dblclick', (e) => handleWordDoubleClick(e));
      // Click for bracket matching, or Ctrl+click for go-to-definition
      text.addEventListener('click', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
          handleGoToDefinition(e, lines);
        } else {
          handleBracketMatch(e, i, lines);
        }
      });
      row.appendChild(num);
      row.appendChild(text);
      table.appendChild(row);
    }
    fileViewerContent.appendChild(table);

    // Update cursor position on scroll + sticky header + minimap slider
    fileViewerContent.addEventListener('scroll', () => {
      updateCursorPosition();
      updateStickyHeader(tab);
      updateMinimapSlider();
    });
    // Initial cursor position
    updateCursorPosition();

    // Render minimap
    renderMinimap(tab);

    // Render bookmarks
    renderBookmarkMarkers();

    // Render inline annotations from terminal
    renderAnnotations(tab);
  }

  // Track last-clicked line for Shift+click range selection
  let lastClickedLine = null;

  function handleLineClick(rowEl, lineNum, e) {
    if (e.shiftKey && lastClickedLine !== null) {
      // Range selection
      const start = Math.min(lastClickedLine, lineNum);
      const end = Math.max(lastClickedLine, lineNum);
      selectLineRange(start, end);
    } else {
      highlightLine(rowEl);
      lastClickedLine = lineNum;
    }
    updateCursorPosition(lineNum);
  }

  function highlightLine(rowEl) {
    // Clear previous highlights
    clearLineHighlights();
    rowEl.classList.add('line-highlighted');
  }

  function clearLineHighlights() {
    const prev = fileViewerContent.querySelectorAll('.line-row.line-highlighted, .line-row.line-range-selected');
    prev.forEach(el => { el.classList.remove('line-highlighted'); el.classList.remove('line-range-selected'); });
  }

  function selectLineRange(start, end) {
    clearLineHighlights();
    const rows = fileViewerContent.querySelectorAll('.line-row');
    const selectedTexts = [];
    rows.forEach(row => {
      const ln = parseInt(row.dataset.lineNum, 10);
      if (ln >= start && ln <= end) {
        row.classList.add('line-range-selected');
        const textEl = row.querySelector('.line-text');
        if (textEl) selectedTexts.push(textEl.textContent);
      }
    });
    // Copy selected range to clipboard
    if (selectedTexts.length > 0) {
      navigator.clipboard.writeText(selectedTexts.join('\n')).then(
        () => showToast(`Copied lines ${start}-${end}`, 'info', 2000),
        () => {}
      );
    }
  }

  function handleWordDoubleClick(e) {
    const sel = window.getSelection();
    const word = sel.toString().trim();
    if (!word || word.length < 2) return;
    // Clear previous word highlights
    clearWordHighlights();
    // Highlight all occurrences of this word in the file viewer
    const lineTexts = fileViewerContent.querySelectorAll('.line-text');
    let count = 0;
    lineTexts.forEach(textEl => {
      const content = textEl.textContent;
      if (content.includes(word)) {
        // Rebuild the text node with highlights
        const frag = document.createDocumentFragment();
        // Preserve indent guides
        const guides = textEl.querySelectorAll('.indent-guide');
        guides.forEach(g => frag.appendChild(g.cloneNode(true)));
        // Split and highlight
        const parts = content.split(word);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) {
            const mark = document.createElement('span');
            mark.className = 'word-highlight';
            mark.textContent = word;
            frag.appendChild(mark);
            count++;
          }
          if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
        }
        textEl.innerHTML = '';
        textEl.appendChild(frag);
      }
    });
    if (count > 0) {
      showToast(`${count} occurrences highlighted`, 'info', 2000);
    }
  }

  function clearWordHighlights() {
    const marks = fileViewerContent.querySelectorAll('.word-highlight');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
  }

  function goToLine(lineNum) {
    const row = fileViewerContent.querySelector(`.line-row[data-line-num="${lineNum}"]`);
    if (row) {
      highlightLine(row);
      row.scrollIntoView({ block: 'center' });
    }
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
    textarea.oninput = () => {
      if (tab.content !== textarea.value) {
        dirtyTabs.add(tab.id);
      } else {
        dirtyTabs.delete(tab.id);
      }
      renderTabs(); // update dirty indicator on tab
      // Auto-save after delay
      scheduleAutoSave(tab, textarea);
    };
    // Editor keyboard shortcuts
    textarea.onkeydown = (e) => {
      // Ctrl+D: select next occurrence
      if (e.key === 'd' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        selectNextOccurrence(textarea);
        return;
      }
      // Alt+Shift+Up: copy line up
      if (e.key === 'ArrowUp' && e.altKey && e.shiftKey) {
        e.preventDefault();
        copyLineInEditor(textarea, -1);
        return;
      }
      // Alt+Shift+Down: copy line down
      if (e.key === 'ArrowDown' && e.altKey && e.shiftKey) {
        e.preventDefault();
        copyLineInEditor(textarea, 1);
        return;
      }
    };
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
      dirtyTabs.delete(tab.id);
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

  // Toggle replace row
  if (fvToggleReplace) {
    fvToggleReplace.onclick = () => {
      if (!fvReplaceRow) return;
      const visible = !fvReplaceRow.classList.contains('hidden');
      fvReplaceRow.classList.toggle('hidden', visible);
      fvToggleReplace.classList.toggle('fv-toggle-replace-open', !visible);
      if (!visible) fvReplaceInput.focus();
    };
  }

  // Replace current match
  if (fvReplaceOne) {
    fvReplaceOne.onclick = () => {
      const tab = openTabs.find(t => t.id === activeTabId);
      if (!tab || !tab.content || fvSearchMatches.length === 0) return;
      const searchText = fvSearchInput.value.trim();
      const replaceText = fvReplaceInput.value;
      if (!searchText) return;
      // Replace one occurrence in content
      const idx = findNthOccurrence(tab.content, searchText, fvSearchCurrentIdx);
      if (idx >= 0) {
        tab.content = tab.content.substring(0, idx) + replaceText + tab.content.substring(idx + searchText.length);
        dirtyTabs.add(tab.id);
        renderFileContent(tab);
        renderTabs();
        // Re-search to update highlights
        performFvSearch(searchText);
      }
    };
  }

  // Replace all matches
  if (fvReplaceAll) {
    fvReplaceAll.onclick = () => {
      const tab = openTabs.find(t => t.id === activeTabId);
      if (!tab || !tab.content || fvSearchMatches.length === 0) return;
      const searchText = fvSearchInput.value.trim();
      const replaceText = fvReplaceInput.value;
      if (!searchText) return;
      const count = fvSearchMatches.length;
      tab.content = tab.content.split(searchText).join(replaceText);
      dirtyTabs.add(tab.id);
      renderFileContent(tab);
      renderTabs();
      performFvSearch(searchText);
      showToast(`Replaced ${count} occurrence${count !== 1 ? 's' : ''}`, 'success', 2000);
    };
  }

  function findNthOccurrence(content, search, n) {
    const lower = content.toLowerCase();
    const q = search.toLowerCase();
    let idx = -1;
    for (let i = 0; i <= n; i++) {
      idx = lower.indexOf(q, idx + 1);
      if (idx < 0) return -1;
    }
    return idx;
  }

  // --- Go to line ---
  function openGoToLine() {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content) return;
    const totalLines = tab.content.split('\n').length;

    const overlay = document.createElement('div');
    overlay.className = 'goto-overlay';
    const box = document.createElement('div');
    box.className = 'goto-box';
    const label = document.createElement('label');
    label.textContent = `Go to line (1\u2013${totalLines}):`;
    label.className = 'goto-label';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = 1;
    input.max = totalLines;
    input.className = 'goto-input';
    input.placeholder = 'Line number';
    box.appendChild(label);
    box.appendChild(input);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();

    const cleanup = () => overlay.remove();
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const num = parseInt(input.value);
        if (num >= 1 && num <= totalLines) goToLine(num);
        cleanup();
      }
      if (e.key === 'Escape') cleanup();
    };
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
  }

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

    // Ctrl+G — go to line (only when viewing a file)
    if (e.key === 'g' && (e.ctrlKey || e.metaKey) && activeTabId !== 'claude') {
      e.preventDefault();
      openGoToLine();
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
      if (cmdHistoryPanel) cmdHistoryPanel.classList.add('hidden');
      if (outlinePanel) outlinePanel.classList.add('hidden');
      btnRefreshFileTree.style.display = '';
      btnToggleFileTree.style.display = '';
      if (btnExpandAll) btnExpandAll.style.display = '';
      if (btnCollapseAll) btnCollapseAll.style.display = '';
      if (searchBox) searchBox.style.display = '';
    } else if (tab === 'git') {
      fileTreeEl.classList.add('hidden');
      gitPanel.classList.remove('hidden');
      if (cmdHistoryPanel) cmdHistoryPanel.classList.add('hidden');
      if (outlinePanel) outlinePanel.classList.add('hidden');
      btnRefreshFileTree.style.display = 'none';
      btnToggleFileTree.style.display = 'none';
      if (btnExpandAll) btnExpandAll.style.display = 'none';
      if (btnCollapseAll) btnCollapseAll.style.display = 'none';
      if (searchBox) searchBox.style.display = 'none';
      setGitTabBadge(false);
      refreshGitStatus();
    } else if (tab === 'outline') {
      fileTreeEl.classList.add('hidden');
      gitPanel.classList.add('hidden');
      if (cmdHistoryPanel) cmdHistoryPanel.classList.add('hidden');
      if (outlinePanel) outlinePanel.classList.remove('hidden');
      btnRefreshFileTree.style.display = 'none';
      btnToggleFileTree.style.display = 'none';
      if (btnExpandAll) btnExpandAll.style.display = 'none';
      if (btnCollapseAll) btnCollapseAll.style.display = 'none';
      if (searchBox) searchBox.style.display = 'none';
      renderOutlinePanel();
    } else if (tab === 'history') {
      fileTreeEl.classList.add('hidden');
      gitPanel.classList.add('hidden');
      if (cmdHistoryPanel) cmdHistoryPanel.classList.remove('hidden');
      if (outlinePanel) outlinePanel.classList.add('hidden');
      btnRefreshFileTree.style.display = 'none';
      btnToggleFileTree.style.display = 'none';
      if (btnExpandAll) btnExpandAll.style.display = 'none';
      if (btnCollapseAll) btnCollapseAll.style.display = 'none';
      if (searchBox) searchBox.style.display = 'none';
      renderCommandHistory();
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

  // --- New feature button handlers ---

  if (statusNotify) {
    statusNotify.onclick = toggleNotifications;
  }

  if (statusTheme) {
    statusTheme.onclick = toggleTheme;
  }

  if (statusExport) {
    statusExport.onclick = exportSessionOutput;
    statusExport.oncontextmenu = (e) => {
      e.preventDefault();
      exportSessionMarkdown();
    };
  }

  // --- Prompt input bar ---

  function showPromptBar() {
    if (!activeSessionId) return;
    promptBar.classList.remove('hidden');
    // Adjust terminal wrapper bottom inset
    const termWrapper = document.getElementById('terminal-wrapper');
    if (termWrapper && termWrapper.style.display !== 'none') {
      termWrapper.style.inset = `${getTopInset()} 0 ${getPromptBottomInset()} 0`;
      if (fitAddon) fitAddon.fit();
    }
  }

  function hidePromptBar() {
    promptBar.classList.add('hidden');
  }

  function getPromptBottomInset() {
    const statusH = statusBar && !statusBar.classList.contains('hidden') ? 24 : 0;
    const promptH = promptBar && !promptBar.classList.contains('hidden') ? promptBar.offsetHeight : 0;
    return (statusH + promptH) + 'px';
  }

  function sendPromptInput() {
    if (!activeSessionId) return;
    let text = promptInput.value;
    // Prepend attached file references
    if (attachedFiles.length > 0) {
      const refs = attachedFiles.map(f => '@' + f).join(' ');
      text = refs + ' ' + text;
    }
    if (!text.trim()) return;
    // Save to prompt history
    const raw = promptInput.value.trim();
    if (raw && (promptHistory.length === 0 || promptHistory[promptHistory.length - 1] !== raw)) {
      promptHistory.push(raw);
      if (promptHistory.length > MAX_PROMPT_HISTORY) promptHistory.shift();
    }
    promptHistoryIdx = -1;
    promptHistoryDraft = '';
    // Track in command history panel
    addCommandHistory(raw);
    // Send text to terminal followed by Enter
    wsSend(JSON.stringify({ type: 'input', data: text + '\r' }));
    promptInput.value = '';
    promptInput.style.height = 'auto';
    attachedFiles = [];
    renderFileChips();
    term.focus();
  }

  if (promptSend) {
    promptSend.onclick = sendPromptInput;
  }

  if (promptInput) {
    // Auto-grow textarea
    promptInput.oninput = () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
      // Re-adjust terminal inset
      const termWrapper = document.getElementById('terminal-wrapper');
      if (termWrapper && termWrapper.style.display !== 'none') {
        termWrapper.style.inset = `${getTopInset()} 0 ${getPromptBottomInset()} 0`;
        if (fitAddon) fitAddon.fit();
      }
      // Update token count estimate
      updateTokenCount(promptInput.value);
    };

    promptInput.onkeydown = (e) => {
      // Enter sends, Shift+Enter for newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPromptInput();
      }
      // Up/Down arrow — prompt history navigation (only when cursor is at line boundary)
      if (e.key === 'ArrowUp' && promptHistory.length > 0) {
        const beforeCursor = promptInput.value.substring(0, promptInput.selectionStart);
        if (!beforeCursor.includes('\n')) { // only at first line
          e.preventDefault();
          if (promptHistoryIdx === -1) {
            promptHistoryDraft = promptInput.value;
            promptHistoryIdx = promptHistory.length - 1;
          } else if (promptHistoryIdx > 0) {
            promptHistoryIdx--;
          }
          promptInput.value = promptHistory[promptHistoryIdx];
          promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
          return;
        }
      }
      if (e.key === 'ArrowDown' && promptHistoryIdx >= 0) {
        const afterCursor = promptInput.value.substring(promptInput.selectionEnd);
        if (!afterCursor.includes('\n')) { // only at last line
          e.preventDefault();
          if (promptHistoryIdx < promptHistory.length - 1) {
            promptHistoryIdx++;
            promptInput.value = promptHistory[promptHistoryIdx];
          } else {
            promptHistoryIdx = -1;
            promptInput.value = promptHistoryDraft;
          }
          promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
          return;
        }
      }
      // Escape focuses terminal
      if (e.key === 'Escape') {
        promptInput.blur();
        term.focus();
      }
    };
  }

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
    // Ctrl+B — toggle mini sidebar
    if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleMiniSidebar();
      return;
    }

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

    // Ctrl+Shift+Z — Toggle Zen mode
    if (e.key === 'Z' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      toggleZenMode();
      return;
    }

    // Ctrl+Shift+M — Toggle bookmark
    if (e.key === 'M' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (activeTabId !== 'claude') {
        const firstRow = fileViewerContent.querySelector('.line-row');
        if (firstRow) {
          const rowHeight = firstRow.offsetHeight || 20;
          const currentLine = Math.floor(fileViewerContent.scrollTop / rowHeight) + 1;
          toggleBookmark(currentLine);
        }
      }
      return;
    }

    // F2 / Shift+F2 — Navigate bookmarks
    if (e.key === 'F2') {
      e.preventDefault();
      navigateBookmark(e.shiftKey ? -1 : 1);
      return;
    }

    // Ctrl+Shift+F — Session search
    if (e.key === 'F' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (sessionSearchOverlay && sessionSearchOverlay.classList.contains('hidden')) {
        openSessionSearch();
      } else {
        closeSessionSearch();
      }
      return;
    }

    // Ctrl+Shift+O — Go to Symbol
    if (e.key === 'O' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (symbolOverlay && symbolOverlay.classList.contains('hidden')) {
        openGoToSymbol();
      } else {
        closeGoToSymbol();
      }
      return;
    }

    // Ctrl+P — quick file open
    if (e.key === 'p' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      if (quickOpenOverlay && quickOpenOverlay.classList.contains('hidden')) {
        openQuickOpen();
      } else {
        closeQuickOpen();
      }
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

    // Ctrl+N — new session (if a project is expanded)
    if (e.key === 'n' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      // Find first expanded project and show new session input
      if (activeSessionId) {
        const session = sessions.find(s => s.id === activeSessionId);
        if (session) {
          const projGroup = projectListEl.querySelector(`[data-project-id="${session.projectId}"]`);
          if (projGroup) {
            expandedProjects.add(session.projectId);
            renderSidebar();
            const ul = projGroup.querySelector('.project-sessions');
            if (ul) showInlineSessionInput(ul, session.projectId);
          }
        }
      } else if (projects.length > 0) {
        const proj = projects[0];
        expandedProjects.add(proj.id);
        renderSidebar();
        const projGroup = projectListEl.querySelector(`[data-project-id="${proj.id}"]`);
        if (projGroup) {
          const ul = projGroup.querySelector('.project-sessions');
          if (ul) showInlineSessionInput(ul, proj.id);
        }
      }
      return;
    }

    // Ctrl+F — find in terminal (when on Claude tab) or file
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      if (activeSessionId && activeTabId === 'claude') {
        e.preventDefault();
        openTermSearch();
        return;
      }
      // For file tabs, the existing fv-search handler in the earlier keydown listener catches it
    }

    // Esc — close overlays, stop Claude, or close terminal search
    if (e.key === 'Escape') {
      if (zenModeActive) {
        toggleZenMode();
        e.stopPropagation();
        return;
      }
      if (splitEditorOverlay && !splitEditorOverlay.classList.contains('hidden')) {
        closeSplitView();
        e.stopPropagation();
        return;
      }
      if (problemsPanel && !problemsPanel.classList.contains('hidden')) {
        problemsPanel.classList.add('hidden');
        e.stopPropagation();
        return;
      }
      if (quickOpenOverlay && !quickOpenOverlay.classList.contains('hidden')) {
        closeQuickOpen();
        e.stopPropagation();
        return;
      }
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
      if (termSearchBar && !termSearchBar.classList.contains('hidden')) {
        closeTermSearch();
        term.focus();
        e.stopPropagation();
        return;
      }
      // Esc while Claude is working sends interrupt
      if (activeSessionId && activeTabId === 'claude') {
        const idle = sessionIdleState.get(activeSessionId);
        const session = sessions.find(s => s.id === activeSessionId);
        if (session && session.alive !== false && idle === false) {
          wsSend(JSON.stringify({ type: 'input', sessionId: activeSessionId, data: '\x03' }));
          return;
        }
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
        { icon: '\u25A3', label: 'Toggle Sidebar', meta: 'Ctrl+B', action: () => { closeCommandPalette(); toggleMiniSidebar(); } },
        { icon: '\u25A3', label: 'Toggle Focus Mode', meta: 'Ctrl+\\', action: () => { closeCommandPalette(); toggleFocusMode(); } },
        { icon: '\u2B1A', label: 'Toggle Zen Mode', meta: 'Ctrl+Shift+Z', action: () => { closeCommandPalette(); toggleZenMode(); } },
        { icon: '\u26A0', label: 'Toggle Problems Panel', meta: 'errors/warnings', action: () => { closeCommandPalette(); toggleProblemsPanel(); } },
        { icon: '\u2261', label: 'Show Outline', meta: 'symbols', action: () => {
          closeCommandPalette();
          const outTab = rightPanelTabs.querySelector('[data-rp-tab="outline"]');
          if (outTab) outTab.click();
        }},
        { icon: '\u2717', label: 'Close All Tabs', meta: 'action', action: () => { closeCommandPalette(); closeAllTabs(); } },
        { icon: '\u25CB', label: 'Toggle Theme', meta: 'light/dark', action: () => { closeCommandPalette(); toggleTheme(); } },
        { icon: '\u21E9', label: 'Export Session Output', meta: 'download .txt', action: () => { closeCommandPalette(); exportSessionOutput(); } },
        { icon: '\u266A', label: 'Toggle Notifications', meta: notificationsEnabled ? 'on' : 'off', action: () => { closeCommandPalette(); toggleNotifications(); } },
        { icon: '\u2398', label: 'Find in Terminal', meta: 'Ctrl+F', action: () => { closeCommandPalette(); openTermSearch(); } },
        { icon: '\u2398', label: 'Clone Session', meta: 'duplicate', action: () => { closeCommandPalette(); cloneSession(activeSessionId); } },
        { icon: '\u2630', label: 'Focus File Tree', meta: 'keyboard nav', action: () => {
          closeCommandPalette();
          const treeSection = document.getElementById('file-tree-section');
          if (treeSection) treeSection.focus();
        }},
        { icon: '\u2610', label: 'Quick Open File', meta: 'Ctrl+P', action: () => { closeCommandPalette(); openQuickOpen(); } },
        { icon: '\u25BD', label: 'Expand All Folders', meta: 'file tree', action: () => { closeCommandPalette(); if (btnExpandAll) btnExpandAll.click(); } },
        { icon: '\u25B7', label: 'Collapse All Folders', meta: 'file tree', action: () => { closeCommandPalette(); if (btnCollapseAll) btnCollapseAll.click(); } },
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
      // Show lines-from-bottom count
      if (scrollLineCount) {
        const buf = term.buffer.active;
        const linesAway = buf.baseY - buf.viewportY;
        if (linesAway > 0) {
          scrollLineCount.textContent = linesAway + (linesAway === 1 ? ' line' : ' lines');
        } else {
          scrollLineCount.textContent = '';
        }
      }
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

  // --- Mini sidebar toggle ---

  function toggleMiniSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('sidebar-mini', sidebarCollapsed);
    requestAnimationFrame(() => {
      if (fitAddon) fitAddon.fit();
      if (shellFitAddon) shellFitAddon.fit();
    });
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

  // --- Stop button ---
  if (stopBtn) {
    stopBtn.onclick = () => {
      if (!activeSessionId) return;
      wsSend(JSON.stringify({ type: 'input', sessionId: activeSessionId, data: '\x03' }));
      term.focus();
    };
  }

  // --- Quick actions menu ---
  let quickActionsVisible = false;

  function showQuickActions() {
    if (!quickActionsMenu || !promptBar) return;
    // Position above prompt bar
    const promptRect = promptBar.getBoundingClientRect();
    quickActionsMenu.style.bottom = (window.innerHeight - promptRect.top + 4) + 'px';
    quickActionsMenu.style.left = promptRect.left + 'px';
    quickActionsMenu.classList.remove('hidden');
    quickActionsVisible = true;
  }

  function hideQuickActions() {
    if (!quickActionsMenu) return;
    quickActionsMenu.classList.add('hidden');
    quickActionsVisible = false;
  }

  if (quickActionsMenu) {
    quickActionsMenu.querySelectorAll('.qa-item').forEach(item => {
      item.onclick = () => {
        const action = item.dataset.action;
        if (action && activeSessionId) {
          wsSend(JSON.stringify({ type: 'input', data: action + '\r' }));
          hideQuickActions();
          promptInput.value = '';
          term.focus();
        }
      };
    });
  }

  // Show quick actions when typing "/" at beginning of prompt
  if (promptInput) {
    const origOninput = promptInput.oninput;
    promptInput.oninput = () => {
      if (origOninput) origOninput();
      const text = promptInput.value;
      if (text === '/') {
        showQuickActions();
      } else if (quickActionsVisible && !text.startsWith('/')) {
        hideQuickActions();
      }
    };

    const origOnkeydown = promptInput.onkeydown;
    promptInput.onkeydown = (e) => {
      if (quickActionsVisible && e.key === 'Escape') {
        e.preventDefault();
        hideQuickActions();
        return;
      }
      if (origOnkeydown) origOnkeydown(e);
    };
  }

  // Close quick actions on outside click
  document.addEventListener('mousedown', (e) => {
    if (quickActionsVisible && quickActionsMenu && !quickActionsMenu.contains(e.target) &&
        promptInput !== e.target) {
      hideQuickActions();
    }
  });

  // --- Terminal search ---
  let termSearchResults = [];
  let termSearchIdx = -1;

  function openTermSearch() {
    if (!termSearchBar || !activeSessionId || activeTabId !== 'claude') return;
    termSearchBar.classList.remove('hidden');
    termSearchInput.value = '';
    termSearchCount.textContent = '';
    termSearchResults = [];
    termSearchIdx = -1;
    termSearchInput.focus();
  }

  function closeTermSearch() {
    if (!termSearchBar) return;
    termSearchBar.classList.add('hidden');
    termSearchResults = [];
    termSearchIdx = -1;
    // Clear search decoration
    clearTermSearchHighlights();
  }

  function clearTermSearchHighlights() {
    // Clear any previous search highlights by marking none
    if (term && term._decorations) {
      for (const d of term._decorations) d.dispose();
      term._decorations = [];
    }
  }

  function searchTermBuffer(query) {
    if (!term || !query) {
      termSearchCount.textContent = '';
      termSearchResults = [];
      termSearchIdx = -1;
      return;
    }

    const q = query.toLowerCase();
    const buf = term.buffer.active;
    const results = [];

    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).toLowerCase();
      let startIdx = 0;
      while (true) {
        const pos = text.indexOf(q, startIdx);
        if (pos === -1) break;
        results.push({ line: i, col: pos, length: query.length });
        startIdx = pos + 1;
      }
    }

    termSearchResults = results;
    if (results.length > 0) {
      termSearchIdx = results.length - 1; // Start from last match
      termSearchCount.textContent = `${termSearchIdx + 1} of ${results.length}`;
      scrollToTermSearchResult();
    } else {
      termSearchIdx = -1;
      termSearchCount.textContent = 'No results';
    }
  }

  function scrollToTermSearchResult() {
    if (termSearchIdx < 0 || termSearchIdx >= termSearchResults.length) return;
    const match = termSearchResults[termSearchIdx];
    term.scrollToLine(match.line);
    termSearchCount.textContent = `${termSearchIdx + 1} of ${termSearchResults.length}`;
  }

  function termSearchNext_() {
    if (termSearchResults.length === 0) return;
    termSearchIdx = (termSearchIdx + 1) % termSearchResults.length;
    scrollToTermSearchResult();
  }

  function termSearchPrev_() {
    if (termSearchResults.length === 0) return;
    termSearchIdx = (termSearchIdx - 1 + termSearchResults.length) % termSearchResults.length;
    scrollToTermSearchResult();
  }

  if (termSearchInput) {
    termSearchInput.oninput = debounce(() => searchTermBuffer(termSearchInput.value), 200);
    termSearchInput.onkeydown = (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        termSearchPrev_();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        termSearchNext_();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeTermSearch();
        term.focus();
      }
    };
  }
  if (termSearchNext) termSearchNext.onclick = termSearchNext_;
  if (termSearchPrev) termSearchPrev.onclick = termSearchPrev_;
  if (termSearchClose) termSearchClose.onclick = () => { closeTermSearch(); term.focus(); };

  // --- Session cloning ---
  async function cloneSession(sessionId) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const cloneName = session.name + ' (copy)';
    await createSession(session.projectId, cloneName, session.provider, session.providerOptions);
  }

  // --- @file autocomplete in prompt ---
  let fileAutoItems = [];
  let fileAutoIdx = -1;
  let fileAutoQuery = '';

  function collectAllFilePaths() {
    const paths = [];
    // Collect from open tabs
    for (const t of openTabs) {
      if (t.type !== 'diff') paths.push(t.fullPath);
    }
    // Collect from file tree
    const labels = fileTreeEl.querySelectorAll('.file-tree-item:not(.file-tree-folder) .file-tree-label');
    labels.forEach(label => {
      const p = label.title || label.textContent;
      if (p && !paths.includes(p)) paths.push(p);
    });
    return paths;
  }

  function showFileAutocomplete(query) {
    if (!fileAutocomplete) return;
    const all = collectAllFilePaths();
    const q = query.toLowerCase();
    fileAutoItems = all.filter(p => {
      const name = p.split('/').pop().toLowerCase();
      const full = p.toLowerCase();
      return name.includes(q) || full.includes(q);
    }).slice(0, 8);

    if (fileAutoItems.length === 0) {
      hideFileAutocomplete();
      return;
    }

    fileAutoIdx = 0;
    fileAutocomplete.innerHTML = '';
    for (let i = 0; i < fileAutoItems.length; i++) {
      const item = document.createElement('div');
      item.className = 'file-auto-item' + (i === 0 ? ' active' : '');
      const fname = fileAutoItems[i].split('/').pop();
      const path = fileAutoItems[i];
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-auto-name';
      nameSpan.textContent = fname;
      const pathSpan = document.createElement('span');
      pathSpan.className = 'file-auto-path';
      pathSpan.textContent = path;
      item.appendChild(nameSpan);
      item.appendChild(pathSpan);
      item.onmousedown = (e) => {
        e.preventDefault();
        selectFileAutoItem(i);
      };
      fileAutocomplete.appendChild(item);
    }
    fileAutocomplete.classList.remove('hidden');
  }

  function hideFileAutocomplete() {
    if (!fileAutocomplete) return;
    fileAutocomplete.classList.add('hidden');
    fileAutoItems = [];
    fileAutoIdx = -1;
    fileAutoQuery = '';
  }

  function selectFileAutoItem(idx) {
    if (idx < 0 || idx >= fileAutoItems.length) return;
    const filePath = fileAutoItems[idx];
    addAttachedFile(filePath);

    // Replace the @query text in the prompt
    const text = promptInput.value;
    const atPos = text.lastIndexOf('@');
    if (atPos >= 0) {
      promptInput.value = text.substring(0, atPos) + text.substring(atPos + 1 + fileAutoQuery.length);
    }
    hideFileAutocomplete();
    promptInput.focus();
  }

  function addAttachedFile(filePath) {
    if (attachedFiles.includes(filePath)) return;
    attachedFiles.push(filePath);
    renderFileChips();
  }

  function removeAttachedFile(filePath) {
    attachedFiles = attachedFiles.filter(f => f !== filePath);
    renderFileChips();
  }

  function renderFileChips() {
    if (!promptFileChips) return;
    promptFileChips.innerHTML = '';
    if (attachedFiles.length === 0) {
      promptFileChips.classList.add('hidden');
      return;
    }
    promptFileChips.classList.remove('hidden');
    for (const f of attachedFiles) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      const fname = f.split('/').pop();
      chip.textContent = fname;
      chip.title = f;
      const x = document.createElement('button');
      x.className = 'file-chip-remove';
      x.textContent = '\u00D7';
      x.onclick = () => removeAttachedFile(f);
      chip.appendChild(x);
      promptFileChips.appendChild(chip);
    }
  }

  // Hook into prompt input for @ detection
  if (promptInput) {
    const prevOninput = promptInput.oninput;
    promptInput.oninput = () => {
      if (prevOninput) prevOninput();
      const text = promptInput.value;
      const cursorPos = promptInput.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);
      const atMatch = beforeCursor.match(/@(\S*)$/);
      if (atMatch) {
        fileAutoQuery = atMatch[1];
        showFileAutocomplete(fileAutoQuery);
      } else {
        hideFileAutocomplete();
      }
    };

    const prevOnkeydown = promptInput.onkeydown;
    promptInput.onkeydown = (e) => {
      // File autocomplete navigation
      if (fileAutocomplete && !fileAutocomplete.classList.contains('hidden')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          fileAutoIdx = (fileAutoIdx + 1) % fileAutoItems.length;
          updateFileAutoSelection();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          fileAutoIdx = (fileAutoIdx - 1 + fileAutoItems.length) % fileAutoItems.length;
          updateFileAutoSelection();
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          if (fileAutoItems.length > 0) {
            e.preventDefault();
            selectFileAutoItem(fileAutoIdx);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideFileAutocomplete();
          return;
        }
      }
      if (prevOnkeydown) prevOnkeydown(e);
    };
  }

  function updateFileAutoSelection() {
    if (!fileAutocomplete) return;
    const items = fileAutocomplete.querySelectorAll('.file-auto-item');
    items.forEach((el, i) => el.classList.toggle('active', i === fileAutoIdx));
  }

  // --- Drag and drop files into prompt ---
  if (promptBar) {
    promptBar.addEventListener('dragover', (e) => {
      e.preventDefault();
      promptBar.classList.add('prompt-dragover');
    });
    promptBar.addEventListener('dragleave', () => {
      promptBar.classList.remove('prompt-dragover');
    });
    promptBar.addEventListener('drop', (e) => {
      e.preventDefault();
      promptBar.classList.remove('prompt-dragover');
      const filePath = e.dataTransfer.getData('text/plain');
      if (filePath) {
        addAttachedFile(filePath);
        promptInput.focus();
      }
    });
  }

  // --- Session pinning ---
  function togglePinSession(sessionId) {
    if (pinnedSessions.has(sessionId)) {
      pinnedSessions.delete(sessionId);
    } else {
      pinnedSessions.add(sessionId);
    }
    try { localStorage.setItem('claude-console-pinned-sessions', JSON.stringify([...pinnedSessions])); } catch {}
    renderSidebar();
  }

  // --- Git diff preview ---
  let gitDiffPreviewVisible = false;

  if (btnGitPreview) {
    btnGitPreview.onclick = async () => {
      if (gitDiffPreviewVisible) {
        gitDiffPreview.classList.add('hidden');
        gitDiffPreviewVisible = false;
        btnGitPreview.textContent = 'Preview';
        return;
      }
      if (!activeSessionId) return;
      btnGitPreview.textContent = 'Loading...';
      try {
        const res = await fetch(`/api/sessions/${activeSessionId}/git/diff?staged=true`);
        if (!res.ok) {
          showToast('Failed to load diff preview', 'error');
          btnGitPreview.textContent = 'Preview';
          return;
        }
        const data = await res.json();
        gitDiffPreview.innerHTML = '';
        if (!data.diff || data.diff.trim() === '') {
          gitDiffPreview.textContent = 'No staged changes to preview.';
        } else {
          const pre = document.createElement('pre');
          pre.className = 'git-diff-preview-content';
          const lines = data.diff.split('\n');
          for (const line of lines) {
            const span = document.createElement('span');
            if (line.startsWith('+') && !line.startsWith('+++')) {
              span.className = 'diff-add';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              span.className = 'diff-del';
            } else if (line.startsWith('@@')) {
              span.className = 'diff-hunk';
            } else if (line.startsWith('diff ') || line.startsWith('index ')) {
              span.className = 'diff-header';
            }
            span.textContent = line;
            pre.appendChild(span);
            pre.appendChild(document.createTextNode('\n'));
          }
          gitDiffPreview.appendChild(pre);
        }
        gitDiffPreview.classList.remove('hidden');
        gitDiffPreviewVisible = true;
        btnGitPreview.textContent = 'Hide';
      } catch {
        showToast('Failed to load diff preview', 'error');
        btnGitPreview.textContent = 'Preview';
      }
    };
  }

  // --- Image paste into prompt ---
  const promptImagePreviews = document.getElementById('prompt-image-previews');
  let pastedImages = []; // {name, dataUrl, blob}

  if (promptInput) {
    promptInput.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            const name = `pasted-image-${pastedImages.length + 1}.png`;
            pastedImages.push({ name, dataUrl, blob });
            renderImagePreviews();
          };
          reader.readAsDataURL(blob);
          break; // only handle first image
        }
      }
    });
  }

  function renderImagePreviews() {
    if (!promptImagePreviews) return;
    promptImagePreviews.innerHTML = '';
    if (pastedImages.length === 0) {
      promptImagePreviews.classList.add('hidden');
      return;
    }
    promptImagePreviews.classList.remove('hidden');
    for (let i = 0; i < pastedImages.length; i++) {
      const img = pastedImages[i];
      const container = document.createElement('div');
      container.className = 'prompt-image-preview';
      const thumb = document.createElement('img');
      thumb.src = img.dataUrl;
      thumb.alt = img.name;
      thumb.title = img.name;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'prompt-image-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.onclick = () => {
        pastedImages.splice(i, 1);
        renderImagePreviews();
      };
      container.appendChild(thumb);
      container.appendChild(removeBtn);
      promptImagePreviews.appendChild(container);
    }
  }

  // --- Keyboard file tree navigation ---
  let fileTreeFocusedItem = null;

  function initFileTreeKeyboard() {
    const treeSection = document.getElementById('file-tree-section');
    if (!treeSection) return;

    // Make file tree section focusable
    treeSection.setAttribute('tabindex', '-1');

    treeSection.addEventListener('keydown', (e) => {
      const allItems = [...fileTreeEl.querySelectorAll('.file-tree-item:not(.filter-hidden)')];
      if (allItems.length === 0) return;

      let currentIdx = fileTreeFocusedItem ? allItems.indexOf(fileTreeFocusedItem) : -1;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        currentIdx = Math.min(currentIdx + 1, allItems.length - 1);
        focusFileTreeItem(allItems, currentIdx);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        currentIdx = Math.max(currentIdx - 1, 0);
        focusFileTreeItem(allItems, currentIdx);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileTreeFocusedItem) fileTreeFocusedItem.click();
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        // Expand folder
        if (fileTreeFocusedItem && fileTreeFocusedItem.classList.contains('file-tree-folder')) {
          const arrow = fileTreeFocusedItem.querySelector('.file-tree-arrow');
          if (arrow && arrow.textContent === '\u25B6') {
            e.preventDefault();
            fileTreeFocusedItem.click();
          }
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'h') {
        // Collapse folder
        if (fileTreeFocusedItem && fileTreeFocusedItem.classList.contains('file-tree-folder')) {
          const arrow = fileTreeFocusedItem.querySelector('.file-tree-arrow');
          if (arrow && arrow.textContent === '\u25BC') {
            e.preventDefault();
            fileTreeFocusedItem.click();
          }
        }
      } else if (e.key === 'Escape') {
        clearFileTreeFocus();
        term.focus();
      }
    });
  }

  function focusFileTreeItem(allItems, idx) {
    if (fileTreeFocusedItem) fileTreeFocusedItem.classList.remove('file-tree-focused');
    fileTreeFocusedItem = allItems[idx];
    if (fileTreeFocusedItem) {
      fileTreeFocusedItem.classList.add('file-tree-focused');
      fileTreeFocusedItem.scrollIntoView({ block: 'nearest' });
    }
  }

  function clearFileTreeFocus() {
    if (fileTreeFocusedItem) {
      fileTreeFocusedItem.classList.remove('file-tree-focused');
      fileTreeFocusedItem = null;
    }
  }

  // --- Session context menu ---
  function showSessionContextMenu(e, session) {
    e.preventDefault();
    // Remove any existing context menu
    const existing = document.getElementById('session-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'session-context-menu';
    menu.className = 'context-menu';

    const items = [
      { label: 'Rename', action: () => {
        const nameEl = projectListEl.querySelector(`li[data-session-id="${session.id}"] .session-name`);
        if (nameEl) startSessionRename(nameEl, session.id, session.name);
      }},
      { label: pinnedSessions.has(session.id) ? 'Unpin' : 'Pin to Top', action: () => togglePinSession(session.id) },
      { label: 'Set Color Label', action: () => {
        // Re-find the session element and show color picker near it
        const li = projectListEl.querySelector(`li[data-session-id="${session.id}"]`);
        if (li) {
          const rect = li.getBoundingClientRect();
          showSessionColorPicker({ stopPropagation: () => {}, target: li }, session.id);
        }
      }},
      { label: 'Clone', action: () => cloneSession(session.id) },
      { type: 'separator' },
      { label: 'Copy Session ID', action: () => {
        navigator.clipboard.writeText(session.id);
        showToast('Session ID copied', 'success', 2000);
      }},
      { label: 'Copy Branch Name', action: () => {
        if (session.branchName) {
          navigator.clipboard.writeText(session.branchName);
          showToast('Branch name copied', 'success', 2000);
        }
      }, disabled: !session.branchName },
    ];

    if (session.worktreePath) {
      items.push({ type: 'separator' });
      items.push({ label: 'Archive', action: () => archiveSession(session.id, session.branchName) });
    }

    items.push({ type: 'separator' });
    items.push({ label: 'Delete', className: 'context-menu-danger', action: () => deleteSession(session.id) });

    for (const item of items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        menu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'context-menu-item' + (item.className ? ' ' + item.className : '') + (item.disabled ? ' disabled' : '');
      el.textContent = item.label;
      if (!item.disabled) {
        el.onclick = () => {
          menu.remove();
          item.action();
        };
      }
      menu.appendChild(el);
    }

    // Position near cursor, clamping to viewport
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    let top = e.clientY;
    let left = e.clientX;
    if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 4;
    if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 4;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';

    // Close on outside click
    const closeCtx = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeCtx);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeCtx), 0);
  }

  // --- Enhanced file viewer breadcrumb navigation ---
  // The existing renderFileViewerBreadcrumb already makes directory segments clickable to
  // expand the file tree. We enhance it to also navigate to the parent folder in the file list
  // (already implemented in the existing code, enhancement is the browse-to-folder ability).

  // --- Auto-reload for externally changed files ---
  let fileWatchTimers = new Map(); // tabId -> {timer, mtime}

  function startWatchingFile(tabId, filePath) {
    stopWatchingFile(tabId);
    const timer = setInterval(async () => {
      if (!activeSessionId) return;
      try {
        const res = await fetch(`/api/file/mtime?sessionId=${activeSessionId}&path=${encodeURIComponent(filePath)}`);
        if (!res.ok) return;
        const data = await res.json();
        const entry = fileWatchTimers.get(tabId);
        if (!entry) return;
        if (entry.mtime && data.mtime && data.mtime !== entry.mtime) {
          // File changed externally
          entry.mtime = data.mtime;
          const tab = openTabs.find(t => t.id === tabId);
          if (tab && !dirtyTabs.has(tabId)) {
            showFileChangedBanner(tabId, filePath);
          }
        }
        if (!entry.mtime && data.mtime) {
          entry.mtime = data.mtime;
        }
      } catch { /* ignore poll errors */ }
    }, 5000); // poll every 5 seconds
    fileWatchTimers.set(tabId, { timer, mtime: null });
  }

  function stopWatchingFile(tabId) {
    const entry = fileWatchTimers.get(tabId);
    if (entry) {
      clearInterval(entry.timer);
      fileWatchTimers.delete(tabId);
    }
  }

  function showFileChangedBanner(tabId, filePath) {
    // Only show for active tab
    if (tabId !== activeTabId) return;
    // Check if banner already exists
    if (document.getElementById('file-changed-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'file-changed-banner';
    banner.className = 'file-changed-banner';
    banner.innerHTML = '<span>File changed on disk.</span>';

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Reload';
    reloadBtn.onclick = async () => {
      banner.remove();
      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        await refreshFileTab(tab);
      }
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = () => banner.remove();

    banner.appendChild(reloadBtn);
    banner.appendChild(dismissBtn);

    const fvHeader = document.querySelector('.file-viewer-header');
    if (fvHeader) {
      fvHeader.parentElement.insertBefore(banner, fvHeader.nextSibling);
    }
  }

  async function refreshFileTab(tab) {
    if (!activeSessionId || !tab) return;
    try {
      const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}`);
      if (!res.ok) return;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/plain')) {
        tab.content = await res.text();
        tab.type = 'text';
      } else if (contentType.includes('image/')) {
        const blob = await res.blob();
        tab.imageUrl = URL.createObjectURL(blob);
        tab.type = 'image';
      }
      if (tab.id === activeTabId) renderFileContent(tab);
    } catch { /* ignore */ }
  }

  // --- Ctrl+P Quick File Open ---
  let quickOpenIdx = 0;
  let quickOpenItems = [];

  function openQuickOpen() {
    if (!quickOpenOverlay || !activeSessionId) return;
    quickOpenOverlay.classList.remove('hidden');
    quickOpenInput.value = '';
    quickOpenResults.innerHTML = '';
    quickOpenIdx = 0;
    quickOpenItems = [];
    renderQuickOpenResults('');
    quickOpenInput.focus();
  }

  function closeQuickOpen() {
    if (!quickOpenOverlay) return;
    quickOpenOverlay.classList.add('hidden');
  }

  function renderQuickOpenResults(query) {
    const q = query.toLowerCase();
    // Collect all files from file tree
    const paths = collectAllFilePaths();
    // Fuzzy filter
    let items;
    if (!q) {
      // Show recent files first, then others
      const recent = recentFiles.filter(f => paths.includes(f));
      const others = paths.filter(f => !recent.includes(f)).slice(0, 15);
      items = [...recent, ...others].slice(0, 20);
    } else {
      items = paths.filter(p => {
        const name = p.split('/').pop().toLowerCase();
        const full = p.toLowerCase();
        return fuzzyMatch(q, name) || fuzzyMatch(q, full);
      }).sort((a, b) => {
        // Prioritize filename matches over path matches
        const aName = a.split('/').pop().toLowerCase();
        const bName = b.split('/').pop().toLowerCase();
        const aScore = aName.startsWith(q) ? 0 : aName.includes(q) ? 1 : 2;
        const bScore = bName.startsWith(q) ? 0 : bName.includes(q) ? 1 : 2;
        return aScore - bScore;
      }).slice(0, 20);
    }

    quickOpenItems = items;
    quickOpenIdx = 0;
    quickOpenResults.innerHTML = '';

    if (items.length === 0) {
      quickOpenResults.innerHTML = '<div class="quick-open-empty">No files found</div>';
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const el = document.createElement('div');
      el.className = 'quick-open-item' + (i === 0 ? ' active' : '');
      const fname = items[i].split('/').pop();
      const dir = items[i].includes('/') ? items[i].substring(0, items[i].lastIndexOf('/')) : '';
      const isRecent = recentFiles.includes(items[i]);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'quick-open-name';
      nameSpan.textContent = fname;

      const dirSpan = document.createElement('span');
      dirSpan.className = 'quick-open-dir';
      dirSpan.textContent = dir;

      el.appendChild(nameSpan);
      if (isRecent && !q) {
        const badge = document.createElement('span');
        badge.className = 'quick-open-recent-badge';
        badge.textContent = 'recent';
        el.appendChild(badge);
      }
      el.appendChild(dirSpan);

      el.onmousedown = (e) => {
        e.preventDefault();
        selectQuickOpenItem(i);
      };
      el.onmouseenter = () => {
        quickOpenIdx = i;
        updateQuickOpenSelection();
      };
      quickOpenResults.appendChild(el);
    }
  }

  function selectQuickOpenItem(idx) {
    if (idx < 0 || idx >= quickOpenItems.length) return;
    const filePath = quickOpenItems[idx];
    const filename = filePath.split('/').pop();
    closeQuickOpen();
    openFileTab(filePath, filename);
  }

  function updateQuickOpenSelection() {
    const items = quickOpenResults.querySelectorAll('.quick-open-item');
    items.forEach((el, i) => el.classList.toggle('active', i === quickOpenIdx));
  }

  function fuzzyMatch(query, text) {
    let qi = 0;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  if (quickOpenInput) {
    quickOpenInput.oninput = debounce(() => {
      renderQuickOpenResults(quickOpenInput.value.trim());
    }, 100);

    quickOpenInput.onkeydown = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        quickOpenIdx = Math.min(quickOpenIdx + 1, quickOpenItems.length - 1);
        updateQuickOpenSelection();
        const items = quickOpenResults.querySelectorAll('.quick-open-item');
        if (items[quickOpenIdx]) items[quickOpenIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        quickOpenIdx = Math.max(quickOpenIdx - 1, 0);
        updateQuickOpenSelection();
        const items = quickOpenResults.querySelectorAll('.quick-open-item');
        if (items[quickOpenIdx]) items[quickOpenIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectQuickOpenItem(quickOpenIdx);
      } else if (e.key === 'Escape') {
        closeQuickOpen();
      }
    };
  }

  if (quickOpenOverlay) {
    quickOpenOverlay.onclick = (e) => {
      if (e.target === quickOpenOverlay) closeQuickOpen();
    };
  }

  // --- Recent files tracking ---
  function trackRecentFile(filePath) {
    recentFiles = recentFiles.filter(f => f !== filePath);
    recentFiles.unshift(filePath);
    if (recentFiles.length > MAX_RECENT_FILES) recentFiles.pop();
    try { localStorage.setItem('claude-console-recent-files', JSON.stringify(recentFiles)); } catch {}
  }

  // --- Session color labels ---
  const SESSION_COLORS = [
    { name: 'None', value: '' },
    { name: 'Red', value: '#d95555' },
    { name: 'Orange', value: '#d97757' },
    { name: 'Yellow', value: '#d4b87a' },
    { name: 'Green', value: '#7cba6a' },
    { name: 'Blue', value: '#7aadca' },
    { name: 'Purple', value: '#b07acc' },
    { name: 'Pink', value: '#cc7aaa' },
  ];

  function setSessionColor(sessionId, color) {
    if (!color) {
      delete sessionColors[sessionId];
    } else {
      sessionColors[sessionId] = color;
    }
    try { localStorage.setItem('claude-console-session-colors', JSON.stringify(sessionColors)); } catch {}
    renderSidebar();
  }

  function showSessionColorPicker(e, sessionId) {
    e.stopPropagation();
    // Remove existing picker
    const existing = document.getElementById('session-color-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.id = 'session-color-picker';
    picker.className = 'session-color-picker';

    for (const c of SESSION_COLORS) {
      const swatch = document.createElement('button');
      swatch.className = 'color-swatch' + (sessionColors[sessionId] === c.value ? ' active' : '');
      swatch.title = c.name;
      if (c.value) {
        swatch.style.background = c.value;
      } else {
        swatch.textContent = '\u00D7';
        swatch.style.color = '#8c8478';
        swatch.style.fontSize = '12px';
      }
      swatch.onclick = (ev) => {
        ev.stopPropagation();
        setSessionColor(sessionId, c.value);
        picker.remove();
      };
      picker.appendChild(swatch);
    }

    // Position near the target
    document.body.appendChild(picker);
    const rect = e.target.getBoundingClientRect();
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.left = rect.left + 'px';

    const closePicker = (ev) => {
      if (!picker.contains(ev.target)) {
        picker.remove();
        document.removeEventListener('mousedown', closePicker);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closePicker), 0);
  }

  // --- Expand All / Collapse All file tree ---
  if (btnExpandAll) {
    btnExpandAll.onclick = async () => {
      // Collect all directories in the tree and expand them
      const allFolders = fileTreeEl.querySelectorAll('.file-tree-folder');
      for (const folder of allFolders) {
        const item = folder.parentElement;
        if (!item) continue;
        const children = item.querySelector('.file-tree-children');
        const arrow = folder.querySelector('.file-tree-arrow');
        if (children && !children.classList.contains('expanded')) {
          // Get dirPath from the folder
          const label = folder.querySelector('.file-tree-label');
          if (!label) continue;
          // Find the dir path by building from parents
          let dirPath = buildDirPath(folder);
          if (dirPath !== null) {
            expandedDirs.add(dirPath);
          }
        }
      }
      // Re-render tree with all expanded
      await renderFileTreeDir(fileTreeEl, '', 0);
    };
  }

  if (btnCollapseAll) {
    btnCollapseAll.onclick = () => {
      expandedDirs.clear();
      renderFileTreeDir(fileTreeEl, '', 0);
    };
  }

  function buildDirPath(folderRow) {
    // Walk the DOM to build the directory path from nested structure
    const label = folderRow.querySelector('.file-tree-label');
    if (!label) return null;
    const name = label.textContent;

    // Find parent folder rows
    const parts = [name];
    let el = folderRow.parentElement; // the item wrapper
    while (el) {
      const parentChildren = el.parentElement;
      if (!parentChildren || !parentChildren.classList.contains('file-tree-children')) break;
      const parentItem = parentChildren.parentElement;
      if (!parentItem) break;
      const parentRow = parentItem.querySelector(':scope > .file-tree-folder');
      if (parentRow) {
        const parentLabel = parentRow.querySelector('.file-tree-label');
        if (parentLabel) parts.unshift(parentLabel.textContent);
      }
      el = parentItem;
    }
    return parts.join('/');
  }

  // --- File preview tooltip on hover ---
  let previewHoverTimer = null;

  function setupFilePreviewHover(row, filePath) {
    row.addEventListener('mouseenter', () => {
      if (previewHoverTimer) clearTimeout(previewHoverTimer);
      previewHoverTimer = setTimeout(async () => {
        await showFilePreview(filePath, row);
      }, 600);
    });

    row.addEventListener('mouseleave', () => {
      if (previewHoverTimer) { clearTimeout(previewHoverTimer); previewHoverTimer = null; }
      hideFilePreview();
    });
  }

  async function showFilePreview(filePath, anchorEl) {
    if (!filePreviewTooltip || !activeSessionId) return;
    const ext = filePath.split('.').pop().toLowerCase();
    // Only preview text-like files
    const textExts = new Set(['js','ts','jsx','tsx','py','rb','go','rs','java','c','cpp','h','css','html','json','yaml','yml','toml','md','txt','sh','bash','sql','xml','vue','svelte','cfg','ini','env','gitignore','dockerignore']);
    if (!textExts.has(ext)) return;

    try {
      const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/plain')) return;
      const content = await res.text();

      // Show first 8 lines
      const lines = content.split('\n').slice(0, 8);
      const preview = lines.join('\n');
      const lineCount = content.split('\n').length;

      filePreviewTooltip.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'file-preview-header';
      header.textContent = `${filePath} (${lineCount} lines)`;
      const pre = document.createElement('pre');
      pre.className = 'file-preview-content';
      pre.textContent = preview;
      if (content.split('\n').length > 8) {
        pre.textContent += '\n...';
      }
      filePreviewTooltip.appendChild(header);
      filePreviewTooltip.appendChild(pre);

      // Position tooltip near the anchor
      const rect = anchorEl.getBoundingClientRect();
      filePreviewTooltip.style.top = (rect.top) + 'px';
      filePreviewTooltip.style.left = (rect.right + 8) + 'px';
      // Clamp to viewport
      filePreviewTooltip.classList.remove('hidden');
      const ttRect = filePreviewTooltip.getBoundingClientRect();
      if (ttRect.bottom > window.innerHeight) {
        filePreviewTooltip.style.top = Math.max(0, window.innerHeight - ttRect.height - 8) + 'px';
      }
      if (ttRect.right > window.innerWidth) {
        filePreviewTooltip.style.left = (rect.left - ttRect.width - 8) + 'px';
      }
    } catch { /* ignore */ }
  }

  function hideFilePreview() {
    if (filePreviewTooltip) filePreviewTooltip.classList.add('hidden');
  }

  // --- Cursor position & file info in status bar ---

  function updateCursorPosition(lineNum) {
    if (!statusCursorPos) return;
    if (!lineNum) {
      // Estimate from scroll position
      const firstVisible = fileViewerContent.querySelector('.line-row');
      if (!firstVisible) return;
      const scrollTop = fileViewerContent.scrollTop;
      const rowHeight = firstVisible.offsetHeight || 20;
      lineNum = Math.floor(scrollTop / rowHeight) + 1;
    }
    statusCursorPos.textContent = `Ln ${lineNum}`;
    statusCursorPos.classList.remove('hidden');
  }

  function updateFileInfo(tab) {
    if (!statusFileInfo) return;
    if (!tab || !tab.content) {
      statusFileInfo.classList.add('hidden');
      return;
    }
    const lines = tab.content.split('\n').length;
    const bytes = new Blob([tab.content]).size;
    let sizeStr;
    if (bytes < 1024) sizeStr = bytes + ' B';
    else if (bytes < 1024 * 1024) sizeStr = (bytes / 1024).toFixed(1) + ' KB';
    else sizeStr = (bytes / (1024 * 1024)).toFixed(1) + ' MB';

    const ext = tab.filename.split('.').pop().toUpperCase();
    statusFileInfo.textContent = `${lines} lines \u00B7 ${sizeStr} \u00B7 ${ext}`;
    statusFileInfo.classList.remove('hidden');
  }

  // --- Enhanced session export as Markdown ---

  function exportSessionMarkdown() {
    if (!term || !activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    const name = session ? session.name : 'session';
    const project = session ? projects.find(p => p.id === session.projectId) : null;

    // Extract text from terminal buffer
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i <= buf.length - 1; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    // Parse terminal output into sections
    const sections = [];
    let currentSection = { type: 'output', lines: [] };

    for (const line of lines) {
      // Detect user prompts (lines starting with > or $)
      if (/^[\$>]\s/.test(line.trim())) {
        if (currentSection.lines.length > 0) {
          sections.push(currentSection);
        }
        currentSection = { type: 'prompt', lines: [line] };
      } else {
        if (currentSection.type === 'prompt' && currentSection.lines.length > 0) {
          sections.push(currentSection);
          currentSection = { type: 'output', lines: [] };
        }
        currentSection.lines.push(line);
      }
    }
    if (currentSection.lines.length > 0) sections.push(currentSection);

    // Build Markdown
    let md = `# Session: ${name}\n\n`;
    md += `- **Project:** ${project ? project.name : 'Unknown'}\n`;
    md += `- **Date:** ${new Date().toISOString().split('T')[0]}\n`;
    md += `- **Session ID:** ${activeSessionId}\n`;
    if (session && session.createdAt) {
      md += `- **Created:** ${new Date(session.createdAt).toLocaleString()}\n`;
    }
    md += '\n---\n\n';

    for (const section of sections) {
      if (section.type === 'prompt') {
        md += '**User:**\n\n';
        md += '```\n' + section.lines.join('\n') + '\n```\n\n';
      } else {
        const text = section.lines.join('\n').trim();
        if (text) {
          md += text + '\n\n';
        }
      }
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_session.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Session exported as Markdown', 'success', 2000);
  }

  // --- Go to Symbol (Ctrl+Shift+O) ---

  const SYMBOL_PATTERNS = [
    { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,  kind: 'function' },
    { regex: /^\s*(?:export\s+)?class\s+(\w+)/,                   kind: 'class' },
    { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, kind: 'function' },
    { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: 'function' },
    { regex: /^\s*(?:export\s+)?interface\s+(\w+)/,                kind: 'interface' },
    { regex: /^\s*(?:export\s+)?type\s+(\w+)/,                    kind: 'type' },
    { regex: /^\s*(?:export\s+)?enum\s+(\w+)/,                    kind: 'enum' },
    { regex: /^\s*def\s+(\w+)\s*\(/,                              kind: 'function' },
    { regex: /^\s*class\s+(\w+)[:(]/,                             kind: 'class' },
    { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,            kind: 'function' },
    { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/,                     kind: 'struct' },
    { regex: /^\s*func\s+(\w+)/,                                  kind: 'function' },
    { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/,  kind: 'method' },
  ];

  function parseSymbols(content) {
    const lines = content.split('\n');
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
      for (const pat of SYMBOL_PATTERNS) {
        const m = lines[i].match(pat.regex);
        if (m) {
          symbols.push({ name: m[1], kind: pat.kind, line: i + 1, text: lines[i].trim() });
          break;
        }
      }
    }
    return symbols;
  }

  const SYMBOL_ICONS = {
    'function': '\u0192',
    'class': '\u25C6',
    'interface': '\u25CB',
    'type': 'T',
    'enum': 'E',
    'struct': 'S',
    'method': 'M',
  };

  function openGoToSymbol() {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content || tab.type !== 'text') return;

    const symbols = parseSymbols(tab.content);
    if (symbols.length === 0) {
      showToast('No symbols found in file', 'info', 2000);
      return;
    }

    symbolOverlay.classList.remove('hidden');
    symbolInput.value = '';
    symbolInput.focus();
    renderSymbolResults(symbols, '');

    symbolInput.oninput = () => {
      renderSymbolResults(symbols, symbolInput.value);
    };

    symbolInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        closeGoToSymbol();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSymbolSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSymbolSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = symbolResults.querySelector('.quick-open-item.active');
        if (active) active.click();
        return;
      }
    };

    symbolOverlay.onclick = (e) => {
      if (e.target === symbolOverlay) closeGoToSymbol();
    };
  }

  let symbolSelectedIdx = 0;

  function renderSymbolResults(symbols, filter) {
    symbolResults.innerHTML = '';
    symbolSelectedIdx = 0;
    const q = filter.toLowerCase();
    const filtered = q ? symbols.filter(s => s.name.toLowerCase().includes(q)) : symbols;

    filtered.slice(0, 50).forEach((sym, idx) => {
      const item = document.createElement('div');
      item.className = 'quick-open-item' + (idx === 0 ? ' active' : '');
      const icon = document.createElement('span');
      icon.className = 'symbol-icon symbol-kind-' + sym.kind;
      icon.textContent = SYMBOL_ICONS[sym.kind] || '?';
      const nameEl = document.createElement('span');
      nameEl.className = 'quick-open-name';
      nameEl.textContent = sym.name;
      const kindEl = document.createElement('span');
      kindEl.className = 'quick-open-path';
      kindEl.textContent = `${sym.kind} : ${sym.line}`;
      item.appendChild(icon);
      item.appendChild(nameEl);
      item.appendChild(kindEl);
      item.onclick = () => {
        closeGoToSymbol();
        goToLine(sym.line);
      };
      symbolResults.appendChild(item);
    });
  }

  function moveSymbolSelection(dir) {
    const items = symbolResults.querySelectorAll('.quick-open-item');
    if (items.length === 0) return;
    items[symbolSelectedIdx]?.classList.remove('active');
    symbolSelectedIdx = Math.max(0, Math.min(items.length - 1, symbolSelectedIdx + dir));
    items[symbolSelectedIdx]?.classList.add('active');
    items[symbolSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function closeGoToSymbol() {
    if (symbolOverlay) symbolOverlay.classList.add('hidden');
  }

  // --- Minimap code overview ---

  function renderMinimap(tab) {
    if (!fvMinimap || !fvMinimapCanvas || !tab.content) return;
    fvMinimap.classList.remove('hidden');

    const lines = tab.content.split('\n');
    const canvas = fvMinimapCanvas;
    const ctx = canvas.getContext('2d');

    const lineHeight = 2;
    const canvasWidth = 80;
    const canvasHeight = Math.min(lines.length * lineHeight, fileViewerContent.clientHeight || 600);

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = canvasHeight + 'px';

    ctx.fillStyle = '#2b2a27';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const scale = canvasHeight / (lines.length * lineHeight);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const y = Math.floor(i * lineHeight * scale);
      const indent = (line.match(/^\s*/) || [''])[0].length;
      const textLen = Math.min(line.trim().length, 60);
      const x = Math.floor(indent * 0.8);
      const width = Math.floor(textLen * 0.8);

      // Color based on content
      if (/^\s*(function|class|def |fn |func |pub )/.test(line)) {
        ctx.fillStyle = 'rgba(217, 167, 87, 0.6)';
      } else if (/^\s*(if|else|for|while|switch|case|return|import|export)/.test(line)) {
        ctx.fillStyle = 'rgba(87, 181, 217, 0.4)';
      } else if (/^\s*(\/\/|#|\/\*)/.test(line)) {
        ctx.fillStyle = 'rgba(140, 132, 120, 0.3)';
      } else {
        ctx.fillStyle = 'rgba(240, 235, 227, 0.25)';
      }
      ctx.fillRect(x, y, Math.max(width, 3), lineHeight - 1);
    }

    // Update slider position
    updateMinimapSlider();

    // Click on minimap to scroll
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const ratio = clickY / canvasHeight;
      fileViewerContent.scrollTop = ratio * fileViewerContent.scrollHeight;
    };

    // Drag slider
    let dragging = false;
    fvMinimapSlider.onmousedown = (e) => {
      e.preventDefault();
      dragging = true;
      document.onmousemove = (e2) => {
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const y = e2.clientY - rect.top;
        const ratio = y / canvasHeight;
        fileViewerContent.scrollTop = ratio * fileViewerContent.scrollHeight;
      };
      document.onmouseup = () => {
        dragging = false;
        document.onmousemove = null;
        document.onmouseup = null;
      };
    };
  }

  function updateMinimapSlider() {
    if (!fvMinimapSlider || !fvMinimapCanvas || !fileViewerContent) return;
    const scrollTop = fileViewerContent.scrollTop;
    const scrollHeight = fileViewerContent.scrollHeight;
    const clientHeight = fileViewerContent.clientHeight;
    const canvasHeight = fvMinimapCanvas.height;

    if (scrollHeight <= clientHeight) {
      fvMinimapSlider.style.display = 'none';
      return;
    }
    fvMinimapSlider.style.display = '';
    const ratio = scrollTop / scrollHeight;
    const viewRatio = clientHeight / scrollHeight;
    fvMinimapSlider.style.top = (ratio * canvasHeight) + 'px';
    fvMinimapSlider.style.height = Math.max(viewRatio * canvasHeight, 20) + 'px';
  }

  // --- Bracket matching ---

  const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}' };
  const CLOSE_BRACKETS = { ')': '(', ']': '[', '}': '{' };

  function handleBracketMatch(e, lineIdx, lines) {
    // Clear previous bracket highlights
    clearBracketHighlights();

    const textEl = e.target.closest('.line-text');
    if (!textEl) return;

    // Get click position within text
    const sel = window.getSelection();
    if (!sel.focusNode || sel.focusNode.nodeType !== Node.TEXT_NODE) return;
    const offset = sel.focusOffset;
    const lineText = lines[lineIdx];
    if (!lineText) return;

    const ch = lineText[offset] || lineText[offset - 1];
    const pos = lineText[offset] && (BRACKET_PAIRS[lineText[offset]] || CLOSE_BRACKETS[lineText[offset]]) ? offset : offset - 1;
    const bracket = lineText[pos];
    if (!bracket) return;

    let matchLine, matchPos;
    if (BRACKET_PAIRS[bracket]) {
      // Search forward for closing bracket
      const result = findMatchingBracket(lines, lineIdx, pos, bracket, BRACKET_PAIRS[bracket], 1);
      if (result) { matchLine = result.line; matchPos = result.pos; }
    } else if (CLOSE_BRACKETS[bracket]) {
      // Search backward for opening bracket
      const result = findMatchingBracket(lines, lineIdx, pos, bracket, CLOSE_BRACKETS[bracket], -1);
      if (result) { matchLine = result.line; matchPos = result.pos; }
    } else {
      return;
    }

    if (matchLine !== undefined) {
      highlightBracket(lineIdx + 1, pos);
      highlightBracket(matchLine + 1, matchPos);
    }
  }

  function findMatchingBracket(lines, startLine, startPos, open, close, dir) {
    let depth = 0;
    let line = startLine;
    let pos = startPos;

    while (line >= 0 && line < lines.length) {
      const text = lines[line];
      const start = line === startLine ? pos : (dir > 0 ? 0 : text.length - 1);
      for (let i = start; i >= 0 && i < text.length; i += dir) {
        const ch = text[i];
        if (ch === open) depth += dir;
        else if (ch === close) depth -= dir;
        if (depth === 0) return { line, pos: i };
      }
      line += dir;
    }
    return null;
  }

  function highlightBracket(lineNum, charPos) {
    const row = fileViewerContent.querySelector(`.line-row[data-line-num="${lineNum}"]`);
    if (!row) return;
    const textEl = row.querySelector('.line-text');
    if (!textEl) return;

    // Find the text node and wrap the character
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null);
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (offset + node.length > charPos) {
        const localPos = charPos - offset;
        const range = document.createRange();
        range.setStart(node, localPos);
        range.setEnd(node, localPos + 1);
        const mark = document.createElement('span');
        mark.className = 'bracket-highlight';
        range.surroundContents(mark);
        return;
      }
      offset += node.length;
    }
  }

  function clearBracketHighlights() {
    const marks = fileViewerContent.querySelectorAll('.bracket-highlight');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
  }

  // --- Code folding ---

  function computeFoldRegions(lines) {
    const regions = [];
    const stack = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Detect opening braces or blocks
      if (trimmed.endsWith('{') || trimmed.endsWith('(') || trimmed.endsWith('[')) {
        stack.push(i);
      }
      // Detect class/function headers for Python-style
      if (/^(def |class |if |for |while |with |try:)/.test(trimmed) && !trimmed.endsWith('{')) {
        const indent = (line.match(/^\s*/) || [''])[0].length;
        // Find end of block by indentation
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (!nextLine) continue; // skip blank lines
          const nextIndent = (lines[j].match(/^\s*/) || [''])[0].length;
          if (nextIndent <= indent) break;
          end = j;
        }
        if (end > i + 1) {
          regions.push({ start: i, end });
        }
      }

      // Detect closing braces
      if (trimmed.startsWith('}') || trimmed.startsWith(')') || trimmed.startsWith(']')) {
        if (stack.length > 0) {
          const start = stack.pop();
          if (i - start > 2) { // Only fold regions with >2 lines
            regions.push({ start, end: i });
          }
        }
      }
    }

    // Deduplicate by start line
    const seen = new Set();
    return regions.filter(r => {
      if (seen.has(r.start)) return false;
      seen.add(r.start);
      return true;
    }).sort((a, b) => a.start - b.start);
  }

  function toggleFold(region, table, btn) {
    const rows = table.querySelectorAll('.line-row');
    const isFolded = btn.classList.contains('folded');

    if (isFolded) {
      // Unfold: show hidden rows
      btn.classList.remove('folded');
      btn.textContent = '\u25BC';
      // Remove fold placeholder
      const placeholder = table.querySelector(`.fold-placeholder[data-fold-start="${region.start}"]`);
      if (placeholder) placeholder.remove();
      rows.forEach(row => {
        const ln = parseInt(row.dataset.lineNum, 10) - 1;
        if (ln > region.start && ln <= region.end) {
          row.classList.remove('folded-line');
        }
      });
    } else {
      // Fold: hide rows in range
      btn.classList.add('folded');
      btn.textContent = '\u25B6';
      const foldedCount = region.end - region.start;
      let insertAfterRow = null;
      rows.forEach(row => {
        const ln = parseInt(row.dataset.lineNum, 10) - 1;
        if (ln === region.start) insertAfterRow = row;
        if (ln > region.start && ln <= region.end) {
          row.classList.add('folded-line');
        }
      });
      // Add fold placeholder
      if (insertAfterRow) {
        const placeholder = document.createElement('div');
        placeholder.className = 'fold-placeholder';
        placeholder.dataset.foldStart = region.start;
        placeholder.textContent = `  \u2026 ${foldedCount} lines folded`;
        placeholder.onclick = () => toggleFold(region, table, btn);
        insertAfterRow.after(placeholder);
      }
    }
  }

  // --- Sticky scroll header (current function/class) ---

  function updateStickyHeader(tab) {
    if (!fvStickyHeader || !tab || tab.type !== 'text') return;

    const scrollTop = fileViewerContent.scrollTop;
    const firstRow = fileViewerContent.querySelector('.line-row');
    if (!firstRow) return;
    const rowHeight = firstRow.offsetHeight || 20;
    const topLine = Math.floor(scrollTop / rowHeight);

    // Find the nearest function/class definition above the current scroll position
    const lines = tab.content.split('\n');
    let headerText = null;
    let headerLine = -1;

    for (let i = topLine; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      // Match function/class/def/fn declarations
      const m = line.match(/^\s*((?:export\s+)?(?:async\s+)?function\s+\w+|(?:export\s+)?class\s+\w+|def\s+\w+|(?:pub\s+)?(?:async\s+)?fn\s+\w+|func\s+\w+)/);
      if (m) {
        headerText = line.trim();
        headerLine = i + 1;
        break;
      }
    }

    if (headerText && topLine > headerLine) {
      fvStickyHeader.textContent = headerText;
      fvStickyHeader.classList.remove('hidden');
      fvStickyHeader.onclick = () => goToLine(headerLine);
      fvStickyHeader.title = `Line ${headerLine} — click to jump`;
    } else {
      fvStickyHeader.classList.add('hidden');
    }
  }

  // --- Diff navigation (next/prev change) ---

  let diffChangeIdx = -1;

  if (fvDiffPrev) {
    fvDiffPrev.onclick = () => navigateDiffChange(-1);
  }
  if (fvDiffNext) {
    fvDiffNext.onclick = () => navigateDiffChange(1);
  }

  function navigateDiffChange(dir) {
    const changes = fileViewerContent.querySelectorAll('.diff-add, .diff-del, .diff-hunk');
    if (changes.length === 0) return;

    diffChangeIdx += dir;
    if (diffChangeIdx < 0) diffChangeIdx = changes.length - 1;
    if (diffChangeIdx >= changes.length) diffChangeIdx = 0;

    changes.forEach(el => el.classList.remove('diff-change-active'));
    const target = changes[diffChangeIdx];
    target.classList.add('diff-change-active');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // --- Session search across all sessions ---

  function openSessionSearch() {
    if (!sessionSearchOverlay) return;
    sessionSearchOverlay.classList.remove('hidden');
    sessionSearchInput.value = '';
    sessionSearchResults.innerHTML = '';
    sessionSearchInput.focus();

    sessionSearchInput.oninput = debounce(() => {
      performSessionSearch(sessionSearchInput.value);
    }, 300);

    sessionSearchInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        closeSessionSearch();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSessionSearchSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSessionSearchSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = sessionSearchResults.querySelector('.quick-open-item.active');
        if (active) active.click();
        return;
      }
    };

    sessionSearchOverlay.onclick = (e) => {
      if (e.target === sessionSearchOverlay) closeSessionSearch();
    };
  }

  let sessionSearchIdx = 0;

  function performSessionSearch(query) {
    sessionSearchResults.innerHTML = '';
    sessionSearchIdx = 0;
    if (!query || query.length < 2) return;

    const q = query.toLowerCase();
    const results = [];

    // Search session names
    for (const session of sessions) {
      const name = (session.name || '').toLowerCase();
      if (name.includes(q)) {
        results.push({ type: 'session', session, matchField: 'name', text: session.name });
      }
    }

    // Search session IDs (useful for finding specific sessions)
    for (const session of sessions) {
      if (session.id.toLowerCase().includes(q) && !results.find(r => r.session?.id === session.id)) {
        results.push({ type: 'session', session, matchField: 'id', text: session.id });
      }
    }

    // Search open tab contents
    for (const tab of openTabs) {
      if (tab.content && tab.content.toLowerCase().includes(q)) {
        const lines = tab.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            results.push({ type: 'file', tab, line: i + 1, text: lines[i].trim().substring(0, 100) });
            if (results.length > 50) break;
          }
        }
      }
      if (results.length > 50) break;
    }

    results.slice(0, 50).forEach((r, idx) => {
      const item = document.createElement('div');
      item.className = 'quick-open-item' + (idx === 0 ? ' active' : '');

      if (r.type === 'session') {
        const icon = document.createElement('span');
        icon.className = 'session-search-icon';
        icon.textContent = '\u25CF';
        const nameEl = document.createElement('span');
        nameEl.className = 'quick-open-name';
        nameEl.textContent = r.session.name || 'Unnamed';
        const detailEl = document.createElement('span');
        detailEl.className = 'quick-open-path';
        const proj = projects.find(p => p.id === r.session.projectId);
        detailEl.textContent = proj ? proj.name : '';
        item.appendChild(icon);
        item.appendChild(nameEl);
        item.appendChild(detailEl);
        item.onclick = () => {
          closeSessionSearch();
          attachSession(r.session.id);
        };
      } else {
        const icon = document.createElement('span');
        icon.className = 'session-search-icon';
        icon.textContent = '\u2263';
        const nameEl = document.createElement('span');
        nameEl.className = 'quick-open-name';
        nameEl.textContent = `${r.tab.filename}:${r.line}`;
        const detailEl = document.createElement('span');
        detailEl.className = 'quick-open-path';
        detailEl.textContent = r.text;
        item.appendChild(icon);
        item.appendChild(nameEl);
        item.appendChild(detailEl);
        item.onclick = () => {
          closeSessionSearch();
          switchTab(r.tab.id);
          setTimeout(() => goToLine(r.line), 100);
        };
      }
      sessionSearchResults.appendChild(item);
    });
  }

  function moveSessionSearchSelection(dir) {
    const items = sessionSearchResults.querySelectorAll('.quick-open-item');
    if (items.length === 0) return;
    items[sessionSearchIdx]?.classList.remove('active');
    sessionSearchIdx = Math.max(0, Math.min(items.length - 1, sessionSearchIdx + dir));
    items[sessionSearchIdx]?.classList.add('active');
    items[sessionSearchIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function closeSessionSearch() {
    if (sessionSearchOverlay) sessionSearchOverlay.classList.add('hidden');
  }

  // --- Line bookmarks ---

  function toggleBookmark(lineNum) {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !lineNum) return;

    if (!bookmarks.has(tab.id)) bookmarks.set(tab.id, new Set());
    const marks = bookmarks.get(tab.id);

    if (marks.has(lineNum)) {
      marks.delete(lineNum);
    } else {
      marks.add(lineNum);
    }

    // Update visual markers
    renderBookmarkMarkers();
  }

  function renderBookmarkMarkers() {
    // Clear existing markers
    fileViewerContent.querySelectorAll('.bookmark-marker').forEach(m => m.remove());
    fileViewerContent.querySelectorAll('.line-row.bookmarked').forEach(r => r.classList.remove('bookmarked'));

    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !bookmarks.has(tab.id)) return;

    const marks = bookmarks.get(tab.id);
    marks.forEach(lineNum => {
      const row = fileViewerContent.querySelector(`.line-row[data-line-num="${lineNum}"]`);
      if (row) {
        row.classList.add('bookmarked');
        const marker = document.createElement('span');
        marker.className = 'bookmark-marker';
        marker.textContent = '\u2691';
        marker.title = `Bookmark line ${lineNum}`;
        marker.onclick = (e) => {
          e.stopPropagation();
          toggleBookmark(lineNum);
        };
        const numEl = row.querySelector('.line-num');
        if (numEl) numEl.insertBefore(marker, numEl.firstChild);
      }
    });
  }

  function navigateBookmark(dir) {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !bookmarks.has(tab.id)) return;

    const marks = [...bookmarks.get(tab.id)].sort((a, b) => a - b);
    if (marks.length === 0) return;

    // Get current visible line
    const firstRow = fileViewerContent.querySelector('.line-row');
    if (!firstRow) return;
    const rowHeight = firstRow.offsetHeight || 20;
    const currentLine = Math.floor(fileViewerContent.scrollTop / rowHeight) + 1;

    let target;
    if (dir > 0) {
      target = marks.find(m => m > currentLine) || marks[0]; // wrap around
    } else {
      target = [...marks].reverse().find(m => m < currentLine) || marks[marks.length - 1]; // wrap around
    }
    if (target) goToLine(target);
  }

  // Bookmark button handlers
  if (fvBookmarkToggle) {
    fvBookmarkToggle.onclick = () => {
      const firstRow = fileViewerContent.querySelector('.line-row');
      if (!firstRow) return;
      const rowHeight = firstRow.offsetHeight || 20;
      const currentLine = Math.floor(fileViewerContent.scrollTop / rowHeight) + 1;
      toggleBookmark(currentLine);
    };
  }
  if (fvBookmarkPrev) fvBookmarkPrev.onclick = () => navigateBookmark(-1);
  if (fvBookmarkNext) fvBookmarkNext.onclick = () => navigateBookmark(1);

  // --- Auto-save with undo ---

  function scheduleAutoSave(tab, textarea) {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      if (!textarea || !tab) return;
      const newContent = textarea.value;
      if (newContent === tab.content) return; // no changes

      autoSaveLastContent = tab.content; // save for undo
      const savedTabId = tab.id;

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

        if (!res.ok) return; // silent fail for auto-save

        tab.content = newContent;
        dirtyTabs.delete(tab.id);
        renderTabs();

        // Show auto-save toast with undo
        if (autosaveToast) {
          autosaveToast.classList.remove('hidden');
          const undoHandler = async () => {
            if (autoSaveLastContent === null) return;
            // Restore previous content
            try {
              await fetch('/api/file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sessionId: activeSessionId,
                  path: tab.fullPath,
                  content: autoSaveLastContent,
                }),
              });
              tab.content = autoSaveLastContent;
              if (textarea) textarea.value = autoSaveLastContent;
              dirtyTabs.delete(tab.id);
              renderTabs();
              showToast('Undo successful', 'success', 2000);
            } catch {
              showToast('Undo failed', 'error');
            }
            autosaveToast.classList.add('hidden');
            autoSaveLastContent = null;
          };
          if (autosaveUndo) {
            autosaveUndo.onclick = undoHandler;
          }
          setTimeout(() => {
            autosaveToast.classList.add('hidden');
            autoSaveLastContent = null;
          }, 5000);
        }
      } catch { /* silent fail */ }
    }, AUTO_SAVE_DELAY);
  }

  // --- Tab preview tooltip ---

  function showTabPreview(tab, anchorEl) {
    if (!tabPreviewTooltip || !tab.content || tab.type === 'image' || tab.type === 'binary') return;

    tabPreviewTooltip.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'tab-preview-header';
    header.textContent = tab.fullPath;

    const pre = document.createElement('pre');
    pre.className = 'tab-preview-content';
    const previewLines = (typeof tab.content === 'string' ? tab.content : '').split('\n').slice(0, 10);
    pre.textContent = previewLines.join('\n');
    if (tab.content.split('\n').length > 10) {
      pre.textContent += '\n\u2026';
    }

    tabPreviewTooltip.appendChild(header);
    tabPreviewTooltip.appendChild(pre);

    const rect = anchorEl.getBoundingClientRect();
    tabPreviewTooltip.style.top = (rect.bottom + 4) + 'px';
    tabPreviewTooltip.style.left = rect.left + 'px';
    tabPreviewTooltip.classList.remove('hidden');

    // Clamp to viewport
    const ttRect = tabPreviewTooltip.getBoundingClientRect();
    if (ttRect.right > window.innerWidth) {
      tabPreviewTooltip.style.left = Math.max(0, window.innerWidth - ttRect.width - 8) + 'px';
    }
    if (ttRect.bottom > window.innerHeight) {
      tabPreviewTooltip.style.top = (rect.top - ttRect.height - 4) + 'px';
    }
  }

  function hideTabPreview() {
    if (tabPreviewTooltip) tabPreviewTooltip.classList.add('hidden');
  }

  // --- Command history panel ---

  function addCommandHistory(text) {
    if (!text || !text.trim()) return;
    commandHistory.push({
      text: text.trim(),
      time: new Date(),
      sessionId: activeSessionId,
      sessionName: (sessions.find(s => s.id === activeSessionId) || {}).name || 'Unknown',
    });
    // Update badge on history tab
    const histTab = document.querySelector('[data-rp-tab="history"]');
    if (histTab && activeRightPanelTab !== 'history') {
      histTab.dataset.badge = 'true';
    }
  }

  function renderCommandHistory() {
    if (!cmdHistoryList) return;
    cmdHistoryList.innerHTML = '';

    // Remove badge
    const histTab = document.querySelector('[data-rp-tab="history"]');
    if (histTab) delete histTab.dataset.badge;

    if (commandHistory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cmd-history-empty';
      empty.textContent = 'No commands sent yet';
      cmdHistoryList.appendChild(empty);
      return;
    }

    // Show most recent first
    for (let i = commandHistory.length - 1; i >= 0; i--) {
      const cmd = commandHistory[i];
      const item = document.createElement('div');
      item.className = 'cmd-history-item';

      const time = document.createElement('span');
      time.className = 'cmd-history-time';
      time.textContent = cmd.time.toLocaleTimeString();

      const text = document.createElement('span');
      text.className = 'cmd-history-text';
      text.textContent = cmd.text.length > 200 ? cmd.text.substring(0, 200) + '\u2026' : cmd.text;

      const actions = document.createElement('div');
      actions.className = 'cmd-history-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'cmd-history-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(cmd.text).catch(() => {});
        showToast('Copied', 'info', 1500);
      };

      const resendBtn = document.createElement('button');
      resendBtn.className = 'cmd-history-btn';
      resendBtn.textContent = 'Resend';
      resendBtn.title = 'Send again';
      resendBtn.onclick = () => {
        if (promptInput) {
          promptInput.value = cmd.text;
          promptInput.focus();
        }
      };

      actions.appendChild(copyBtn);
      actions.appendChild(resendBtn);
      item.appendChild(time);
      item.appendChild(text);
      item.appendChild(actions);
      cmdHistoryList.appendChild(item);
    }
  }

  if (btnCmdHistoryClear) {
    btnCmdHistoryClear.onclick = () => {
      commandHistory.length = 0;
      renderCommandHistory();
    };
  }

  // --- Inline annotations from terminal output ---

  const ANNOTATION_PATTERNS = [
    // ESLint / TypeScript style: file.js:10:5: error message
    { regex: /([^\s:]+\.[a-z]+):(\d+)(?::\d+)?:\s*(error|warning|Error|Warning)[:\s]+(.*)/g, type: null },
    // Python style: File "file.py", line 10
    { regex: /File "([^"]+)", line (\d+)/g, type: 'error' },
    // Rust/Go style: --> file.rs:10:5
    { regex: /-->\s+([^\s:]+):(\d+)/g, type: 'error' },
  ];

  function parseTermAnnotations(data) {
    // Strip ANSI escape sequences
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    for (const pat of ANNOTATION_PATTERNS) {
      pat.regex.lastIndex = 0;
      let match;
      while ((match = pat.regex.exec(clean)) !== null) {
        const filePath = match[1];
        const lineNum = parseInt(match[2], 10);
        const type = pat.type || (match[3] && match[3].toLowerCase().includes('warn') ? 'warning' : 'error');
        const message = match[4] || '';

        if (!termAnnotations.has(filePath)) {
          termAnnotations.set(filePath, []);
        }
        const existing = termAnnotations.get(filePath);
        // Avoid duplicates
        if (!existing.find(a => a.line === lineNum && a.message === message)) {
          existing.push({ line: lineNum, type, message: message.trim() });
          // Keep only last 50 annotations per file
          if (existing.length > 50) existing.shift();
        }
      }
    }
  }

  function renderAnnotations(tab) {
    if (!tab || !tab.fullPath) return;

    // Check for annotations matching this file's name
    const fileName = tab.fullPath.split('/').pop();
    const annotations = termAnnotations.get(fileName) || termAnnotations.get(tab.fullPath) || [];
    if (annotations.length === 0) return;

    for (const ann of annotations) {
      const row = fileViewerContent.querySelector(`.line-row[data-line-num="${ann.line}"]`);
      if (!row) continue;

      // Add annotation inline
      const annEl = document.createElement('span');
      annEl.className = 'line-annotation line-annotation-' + ann.type;
      annEl.textContent = ann.message ? `\u25CF ${ann.type}: ${ann.message}` : `\u25CF ${ann.type}`;
      annEl.title = ann.message;
      row.appendChild(annEl);
      row.classList.add('has-annotation');
    }
  }

  // --- Split editor (side-by-side file view) ---

  let splitLeftTab = null;
  let splitRightTab = null;

  function openSplitView(tab) {
    if (!splitEditorOverlay || !tab) return;
    // If no left pane, put current file there and prompt for second
    if (!splitLeftTab) {
      splitLeftTab = tab;
      renderSplitPane(splitLeftContent, splitLeftFilename, tab);
      // Right pane shows a placeholder
      if (splitRightContent) {
        splitRightContent.innerHTML = '<div class="split-placeholder">Open another file to compare</div>';
        splitRightFilename.textContent = '(none)';
      }
    } else if (!splitRightTab) {
      splitRightTab = tab;
      renderSplitPane(splitRightContent, splitRightFilename, tab);
    } else {
      // Replace right pane
      splitRightTab = tab;
      renderSplitPane(splitRightContent, splitRightFilename, tab);
    }
    splitEditorOverlay.classList.remove('hidden');
    fileViewer.classList.add('hidden');
  }

  function renderSplitPane(contentEl, filenameEl, tab) {
    if (!contentEl || !tab) return;
    filenameEl.textContent = tab.filename || tab.fullPath;
    contentEl.innerHTML = '';
    if (tab.type === 'markdown') {
      contentEl.className = 'split-editor-content markdown-body';
      const rawHtml = marked.parse(tab.content);
      contentEl.innerHTML = DOMPurify.sanitize(rawHtml);
    } else if (tab.content && typeof tab.content === 'string') {
      contentEl.className = 'split-editor-content plain-text';
      const lines = tab.content.split('\n');
      const table = document.createElement('div');
      table.className = 'line-table';
      for (let i = 0; i < lines.length; i++) {
        const row = document.createElement('div');
        row.className = 'line-row';
        row.dataset.lineNum = i + 1;
        const num = document.createElement('span');
        num.className = 'line-num';
        num.textContent = i + 1;
        const text = document.createElement('span');
        text.className = 'line-text';
        text.textContent = lines[i];
        row.appendChild(num);
        row.appendChild(text);
        table.appendChild(row);
      }
      contentEl.appendChild(table);
    }
  }

  function closeSplitView() {
    if (splitEditorOverlay) splitEditorOverlay.classList.add('hidden');
    splitLeftTab = null;
    splitRightTab = null;
    if (activeTabId !== 'claude') {
      fileViewer.classList.remove('hidden');
    }
  }

  if (splitLeftClose) splitLeftClose.onclick = () => {
    if (splitRightTab) {
      splitLeftTab = splitRightTab;
      splitRightTab = null;
      renderSplitPane(splitLeftContent, splitLeftFilename, splitLeftTab);
      splitRightContent.innerHTML = '<div class="split-placeholder">Open another file to compare</div>';
      splitRightFilename.textContent = '(none)';
    } else {
      closeSplitView();
    }
  };
  if (splitRightClose) splitRightClose.onclick = () => {
    splitRightTab = null;
    splitRightContent.innerHTML = '<div class="split-placeholder">Open another file to compare</div>';
    splitRightFilename.textContent = '(none)';
  };

  // Split view button in file viewer toolbar
  if (fvSplitViewBtn) {
    fvSplitViewBtn.onclick = () => {
      const tab = openTabs.find(t => t.id === activeTabId);
      if (tab) openSplitView(tab);
    };
  }

  // Split editor divider drag
  if (splitEditorDivider) {
    let splitDragging = false;
    splitEditorDivider.addEventListener('mousedown', (e) => {
      splitDragging = true;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!splitDragging) return;
      const overlay = splitEditorOverlay;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      if (pct > 20 && pct < 80) {
        const leftPane = document.getElementById('split-editor-left');
        const rightPane = document.getElementById('split-editor-right');
        if (leftPane) leftPane.style.flex = `0 0 ${pct}%`;
        if (rightPane) rightPane.style.flex = `0 0 ${100 - pct}%`;
      }
    });
    document.addEventListener('mouseup', () => {
      if (splitDragging) {
        splitDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // --- Zen mode ---

  function toggleZenMode() {
    zenModeActive = !zenModeActive;
    document.body.classList.toggle('zen-mode', zenModeActive);
    // Refit terminal after layout change
    requestAnimationFrame(() => {
      if (fitAddon) fitAddon.fit();
      if (shellFitAddon) shellFitAddon.fit();
    });
    if (zenModeActive) {
      showToast('Zen mode — press Ctrl+Shift+Z or Esc to exit', 'info', 2000);
    }
  }

  if (statusZen) {
    statusZen.onclick = toggleZenMode;
  }

  // --- Breadcrumb dropdown navigation ---

  async function showBreadcrumbDropdown(dirPath, anchorEl) {
    if (!breadcrumbDropdown) return;

    // Close if already showing this path
    if (!breadcrumbDropdown.classList.contains('hidden') && breadcrumbDropdown.dataset.dirPath === dirPath) {
      breadcrumbDropdown.classList.add('hidden');
      return;
    }

    breadcrumbDropdown.dataset.dirPath = dirPath;
    breadcrumbDropdown.innerHTML = '<div class="bc-dropdown-loading">Loading...</div>';

    // Position below the anchor
    const rect = anchorEl.getBoundingClientRect();
    breadcrumbDropdown.style.top = (rect.bottom + 2) + 'px';
    breadcrumbDropdown.style.left = rect.left + 'px';
    breadcrumbDropdown.classList.remove('hidden');

    // Fetch directory contents
    try {
      const res = await fetch(`/api/browse?sessionId=${activeSessionId}&path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();

      breadcrumbDropdown.innerHTML = '';
      const items = data.entries || data;
      if (!items || items.length === 0) {
        breadcrumbDropdown.innerHTML = '<div class="bc-dropdown-empty">Empty directory</div>';
        return;
      }

      // Sort: directories first, then files
      const sorted = [...items].sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted.slice(0, 30)) {
        const item = document.createElement('div');
        item.className = 'bc-dropdown-item';
        const icon = document.createElement('span');
        icon.className = 'bc-dropdown-icon';
        icon.textContent = entry.type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
        const name = document.createElement('span');
        name.textContent = entry.name;
        item.appendChild(icon);
        item.appendChild(name);

        if (entry.type === 'directory') {
          item.onclick = () => {
            breadcrumbDropdown.classList.add('hidden');
            const fullDir = dirPath + '/' + entry.name;
            if (!expandedDirs.has(fullDir)) {
              expandedDirs.add(fullDir);
              if (!expandedDirs.has(dirPath)) expandedDirs.add(dirPath);
              renderFileTreeDir(fileTreeEl, '', 0);
            }
            if (activeRightPanelTab !== 'files') {
              const filesTab = rightPanelTabs.querySelector('[data-rp-tab="files"]');
              if (filesTab) filesTab.click();
            }
          };
        } else {
          item.onclick = () => {
            breadcrumbDropdown.classList.add('hidden');
            openFileTab(dirPath + '/' + entry.name, entry.name);
          };
        }
        breadcrumbDropdown.appendChild(item);
      }
    } catch {
      breadcrumbDropdown.innerHTML = '<div class="bc-dropdown-empty">Error loading</div>';
    }

    // Close on click outside
    const closeDropdown = (e) => {
      if (!breadcrumbDropdown.contains(e.target) && e.target !== anchorEl) {
        breadcrumbDropdown.classList.add('hidden');
        document.removeEventListener('mousedown', closeDropdown);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeDropdown), 0);
  }

  // --- Selection info in status bar ---

  document.addEventListener('selectionchange', () => {
    if (!statusSelectionInfo) return;
    if (activeTabId === 'claude') {
      statusSelectionInfo.classList.add('hidden');
      return;
    }

    const sel = window.getSelection();
    const text = sel.toString();
    if (!text || text.length === 0) {
      statusSelectionInfo.classList.add('hidden');
      return;
    }

    const chars = text.length;
    const lines = text.split('\n').length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;

    statusSelectionInfo.textContent = `Sel: ${chars} chars, ${words} words, ${lines} lines`;
    statusSelectionInfo.classList.remove('hidden');
  });

  // --- Clickable URLs in file viewer ---

  const URL_REGEX = /(https?:\/\/[^\s"'<>()]+)/g;

  function renderLineTextWithLinks(textEl, lineContent) {
    URL_REGEX.lastIndex = 0;
    let lastIdx = 0;
    let match;
    let hasLinks = false;

    while ((match = URL_REGEX.exec(lineContent)) !== null) {
      hasLinks = true;
      // Text before the URL
      if (match.index > lastIdx) {
        textEl.appendChild(document.createTextNode(lineContent.slice(lastIdx, match.index)));
      }
      // The URL as a link
      const link = document.createElement('a');
      link.className = 'fv-link';
      link.href = match[1];
      link.textContent = match[1];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.onclick = (e) => e.stopPropagation(); // prevent bracket matching
      textEl.appendChild(link);
      lastIdx = match.index + match[0].length;
    }

    if (hasLinks) {
      if (lastIdx < lineContent.length) {
        textEl.appendChild(document.createTextNode(lineContent.slice(lastIdx)));
      }
    } else {
      textEl.appendChild(document.createTextNode(lineContent));
    }
  }

  // --- Problems panel ---

  function updateProblemsCount() {
    let total = 0;
    for (const [, anns] of termAnnotations) {
      total += anns.length;
    }
    if (statusProblems) {
      statusProblems.textContent = total + ' problem' + (total !== 1 ? 's' : '');
      statusProblems.classList.toggle('has-problems', total > 0);
    }
    if (problemsCount) problemsCount.textContent = total;
  }

  function toggleProblemsPanel() {
    if (!problemsPanel) return;
    const isHidden = problemsPanel.classList.contains('hidden');
    if (isHidden) {
      renderProblemsPanel();
      problemsPanel.classList.remove('hidden');
    } else {
      problemsPanel.classList.add('hidden');
    }
  }

  function renderProblemsPanel() {
    if (!problemsList) return;
    problemsList.innerHTML = '';

    let total = 0;
    for (const [filePath, anns] of termAnnotations) {
      if (anns.length === 0) continue;

      const fileGroup = document.createElement('div');
      fileGroup.className = 'problems-file-group';
      const fileHeader = document.createElement('div');
      fileHeader.className = 'problems-file-header';
      fileHeader.textContent = filePath;
      const badge = document.createElement('span');
      badge.className = 'problems-file-count';
      badge.textContent = anns.length;
      fileHeader.appendChild(badge);
      fileGroup.appendChild(fileHeader);

      for (const ann of anns) {
        total++;
        const row = document.createElement('div');
        row.className = 'problems-item problems-item-' + ann.type;
        const icon = document.createElement('span');
        icon.className = 'problems-icon';
        icon.textContent = ann.type === 'error' ? '\u2717' : '\u26A0';
        const msg = document.createElement('span');
        msg.className = 'problems-msg';
        msg.textContent = ann.message || ann.type;
        const loc = document.createElement('span');
        loc.className = 'problems-loc';
        loc.textContent = `Line ${ann.line}`;
        row.appendChild(icon);
        row.appendChild(msg);
        row.appendChild(loc);

        row.onclick = () => {
          // Try to open the file and go to line
          const tab = openTabs.find(t => t.fullPath && t.fullPath.endsWith(filePath));
          if (tab) {
            switchTab(tab.id);
            setTimeout(() => goToLine(ann.line), 100);
          }
        };
        fileGroup.appendChild(row);
      }
      problemsList.appendChild(fileGroup);
    }

    if (total === 0) {
      problemsList.innerHTML = '<div class="problems-empty">No problems detected</div>';
    }
    if (problemsCount) problemsCount.textContent = total;
  }

  if (statusProblems) statusProblems.onclick = toggleProblemsPanel;
  if (problemsPanelClose) problemsPanelClose.onclick = () => problemsPanel.classList.add('hidden');

  // --- Outline/Structure panel ---

  function renderOutlinePanel() {
    if (!outlineList) return;
    outlineList.innerHTML = '';

    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content || typeof tab.content !== 'string') {
      outlineList.innerHTML = '<div class="outline-empty">No file open or no symbols found</div>';
      return;
    }

    const symbols = parseSymbols(tab.content);
    if (symbols.length === 0) {
      outlineList.innerHTML = '<div class="outline-empty">No symbols found</div>';
      return;
    }

    for (const sym of symbols) {
      const item = document.createElement('div');
      item.className = 'outline-item';

      const icon = document.createElement('span');
      icon.className = 'symbol-icon symbol-kind-' + sym.kind;
      icon.textContent = SYMBOL_ICONS[sym.kind] || '?';

      const name = document.createElement('span');
      name.className = 'outline-name';
      name.textContent = sym.name;

      const line = document.createElement('span');
      line.className = 'outline-line';
      line.textContent = ':' + sym.line;

      const kind = document.createElement('span');
      kind.className = 'outline-kind';
      kind.textContent = sym.kind;

      item.appendChild(icon);
      item.appendChild(name);
      item.appendChild(line);
      item.appendChild(kind);

      item.onclick = () => {
        switchTab(tab.id);
        setTimeout(() => goToLine(sym.line), 100);
      };

      outlineList.appendChild(item);
    }
  }

  // --- Ctrl+D select next occurrence in editor ---

  function selectNextOccurrence(textarea) {
    const text = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    // If nothing selected, select the current word
    if (start === end) {
      const before = text.slice(0, start);
      const after = text.slice(start);
      const wordStart = before.search(/\w+$/);
      const wordEnd = after.search(/\W/);
      if (wordStart >= 0) {
        const ws = wordStart;
        const we = wordEnd >= 0 ? start + wordEnd : text.length;
        textarea.setSelectionRange(ws, we);
      }
      return;
    }

    // Find the next occurrence of selected text
    const selected = text.slice(start, end);
    const searchFrom = end;
    let idx = text.indexOf(selected, searchFrom);
    if (idx === -1) {
      // Wrap around
      idx = text.indexOf(selected);
    }
    if (idx >= 0 && idx !== start) {
      textarea.setSelectionRange(idx, idx + selected.length);
      // Scroll to make selection visible
      textarea.blur();
      textarea.focus();
    }
  }

  // --- Alt+Shift+Up/Down copy line in editor ---

  function copyLineInEditor(textarea, dir) {
    const text = textarea.value;
    const start = textarea.selectionStart;

    // Find current line boundaries
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', start);
    if (lineEnd === -1) lineEnd = text.length;

    const line = text.slice(lineStart, lineEnd);

    let newText, newPos;
    if (dir < 0) {
      // Copy line above
      newText = text.slice(0, lineStart) + line + '\n' + text.slice(lineStart);
      newPos = start; // keep cursor at same position
    } else {
      // Copy line below
      newText = text.slice(0, lineEnd) + '\n' + line + text.slice(lineEnd);
      newPos = start + line.length + 1;
    }

    textarea.value = newText;
    textarea.setSelectionRange(newPos, newPos);
    // Trigger input event to update dirty state
    textarea.dispatchEvent(new Event('input'));
  }

  // --- Token count estimator ---

  function estimateTokens(text) {
    if (!text) return 0;
    // Rough approximation: ~4 chars per token for English, ~3 for code
    // This is a simple heuristic, not exact
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    return Math.ceil(Math.max(words * 1.3, chars / 4));
  }

  function updateTokenCount(text) {
    if (!promptTokenCount) return;
    if (!text || text.trim().length === 0) {
      promptTokenCount.classList.add('hidden');
      return;
    }
    const tokens = estimateTokens(text);
    promptTokenCount.textContent = '~' + tokens + ' tok';
    promptTokenCount.classList.remove('hidden');
  }

  // --- Ctrl+click Go to Definition ---

  function handleGoToDefinition(e, lines) {
    e.preventDefault();
    e.stopPropagation();

    // Get the word under cursor
    const sel = window.getSelection();
    if (!sel.focusNode || sel.focusNode.nodeType !== Node.TEXT_NODE) return;

    const textContent = sel.focusNode.textContent;
    const offset = sel.focusOffset;

    // Extract the word at cursor position
    const before = textContent.slice(0, offset);
    const after = textContent.slice(offset);
    const wordStartMatch = before.match(/\w+$/);
    const wordEndMatch = after.match(/^\w+/);
    if (!wordStartMatch && !wordEndMatch) return;
    const word = (wordStartMatch ? wordStartMatch[0] : '') + (wordEndMatch ? wordEndMatch[0] : '');
    if (!word || word.length < 2) return;

    // Search for definition in current file
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.content) return;

    const defPatterns = [
      new RegExp('^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+' + word + '\\b'),
      new RegExp('^\\s*(?:export\\s+)?class\\s+' + word + '\\b'),
      new RegExp('^\\s*(?:const|let|var)\\s+' + word + '\\s*='),
      new RegExp('^\\s*def\\s+' + word + '\\s*\\('),
      new RegExp('^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+' + word + '\\b'),
      new RegExp('^\\s*func\\s+' + word + '\\b'),
      new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + word + '\\b'),
    ];

    for (let i = 0; i < lines.length; i++) {
      for (const pat of defPatterns) {
        if (pat.test(lines[i])) {
          goToLine(i + 1);
          showToast(`Jumped to definition of "${word}" at line ${i + 1}`, 'info', 2000);
          return;
        }
      }
    }

    // Not found in current file — show tooltip
    showToast(`No definition found for "${word}" in current file`, 'info', 2000);
  }

  // --- File comparison ---

  let fileCompareSource = null;
  let fileCompareSelectedIdx = 0;

  function openFileCompare(tab) {
    if (!fileCompareOverlay) return;
    fileCompareSource = tab;
    fileCompareOverlay.classList.remove('hidden');
    fileCompareInput.value = '';
    fileCompareResults.innerHTML = '';
    fileCompareSelectedIdx = 0;
    fileCompareInput.focus();

    // Show all other open tabs as options
    renderFileCompareResults('');

    fileCompareInput.oninput = () => {
      renderFileCompareResults(fileCompareInput.value);
    };

    fileCompareInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        closeFileCompare();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveFileCompareSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveFileCompareSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = fileCompareResults.querySelector('.quick-open-item.active');
        if (active) active.click();
        return;
      }
    };

    fileCompareOverlay.onclick = (e) => {
      if (e.target === fileCompareOverlay) closeFileCompare();
    };
  }

  function renderFileCompareResults(filter) {
    fileCompareResults.innerHTML = '';
    fileCompareSelectedIdx = 0;
    const q = filter.toLowerCase();

    const candidates = openTabs.filter(t =>
      t.id !== fileCompareSource?.id &&
      t.content && typeof t.content === 'string' &&
      (!q || t.filename.toLowerCase().includes(q) || t.fullPath.toLowerCase().includes(q))
    );

    if (candidates.length === 0) {
      fileCompareResults.innerHTML = '<div class="quick-open-empty">No other text files open to compare</div>';
      return;
    }

    candidates.slice(0, 20).forEach((tab, idx) => {
      const item = document.createElement('div');
      item.className = 'quick-open-item' + (idx === 0 ? ' active' : '');
      const nameEl = document.createElement('span');
      nameEl.className = 'quick-open-name';
      nameEl.textContent = tab.filename;
      const pathEl = document.createElement('span');
      pathEl.className = 'quick-open-path';
      pathEl.textContent = tab.fullPath;
      item.appendChild(nameEl);
      item.appendChild(pathEl);
      item.onclick = () => {
        closeFileCompare();
        showFileComparison(fileCompareSource, tab);
      };
      fileCompareResults.appendChild(item);
    });
  }

  function moveFileCompareSelection(dir) {
    const items = fileCompareResults.querySelectorAll('.quick-open-item');
    if (items.length === 0) return;
    items[fileCompareSelectedIdx]?.classList.remove('active');
    fileCompareSelectedIdx = Math.max(0, Math.min(items.length - 1, fileCompareSelectedIdx + dir));
    items[fileCompareSelectedIdx]?.classList.add('active');
    items[fileCompareSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function closeFileCompare() {
    if (fileCompareOverlay) fileCompareOverlay.classList.add('hidden');
    fileCompareSource = null;
  }

  function showFileComparison(tabA, tabB) {
    if (!tabA || !tabB) return;
    // Use split editor to show both files
    splitLeftTab = null;
    splitRightTab = null;

    // Render both panes
    openSplitView(tabA);
    openSplitView(tabB);

    // Add diff highlighting
    highlightSplitDifferences(tabA.content, tabB.content);
  }

  function highlightSplitDifferences(textA, textB) {
    if (!splitLeftContent || !splitRightContent) return;
    const linesA = textA.split('\n');
    const linesB = textB.split('\n');
    const maxLen = Math.max(linesA.length, linesB.length);

    const leftRows = splitLeftContent.querySelectorAll('.line-row');
    const rightRows = splitRightContent.querySelectorAll('.line-row');

    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] || '';
      const b = linesB[i] || '';
      if (a !== b) {
        if (leftRows[i]) leftRows[i].classList.add('compare-diff');
        if (rightRows[i]) rightRows[i].classList.add('compare-diff');
      }
    }
  }

  // --- Init ---
  initTerminal();
  initShellTerminal();
  initFileTreeKeyboard();
  startSidebarTimeUpdates();
  updateFontSizeDisplay();
  connect();
})();
