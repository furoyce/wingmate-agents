// src/server/html.ts — Self-contained, high-performance HTML/CSS/JS dashboard for the Wingmate Architect Command Center.
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wingmate · Architect Command Center</title>
  <style>
    :root, body[data-theme="light"] {
      --bg: #F8FAFC;
      --surface: #FFFFFF;
      --surface-elevated: #F1F5F9;
      --surface-hover: #E2E8F0;
      --border: #E2E8F0;
      --border-subtle: #CBD5E1;
      --text: #0F172A;
      --text-muted: #475569;
      --text-dim: #64748B;
      --accent: #0284C7;
      --accent-glow: rgba(2, 132, 199, 0.12);
      --success: #059669;
      --success-glow: rgba(5, 150, 105, 0.12);
      --warning: #D97706;
      --warning-glow: rgba(217, 119, 6, 0.12);
      --danger: #DC2626;
      --purple: #7C3AED;
      --purple-glow: rgba(124, 58, 237, 0.12);
      --card-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    body[data-theme="dark"] {
      --bg: #090D16;
      --surface: #111726;
      --surface-elevated: #182235;
      --surface-hover: #1F2C45;
      --border: #23314B;
      --border-subtle: #192337;
      --text: #F1F5F9;
      --text-muted: #94A3B8;
      --text-dim: #64748B;
      --accent: #38BDF8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --success: #10B981;
      --success-glow: rgba(16, 185, 129, 0.15);
      --warning: #F59E0B;
      --warning-glow: rgba(245, 158, 11, 0.15);
      --danger: #EF4444;
      --purple: #A855F7;
      --purple-glow: rgba(168, 85, 247, 0.15);
      --card-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] {
        --bg: #090D16;
        --surface: #111726;
        --surface-elevated: #182235;
        --surface-hover: #1F2C45;
        --border: #23314B;
        --border-subtle: #192337;
        --text: #F1F5F9;
        --text-muted: #94A3B8;
        --text-dim: #64748B;
        --accent: #38BDF8;
        --accent-glow: rgba(56, 189, 248, 0.15);
        --success: #10B981;
        --success-glow: rgba(16, 185, 129, 0.15);
        --warning: #F59E0B;
        --warning-glow: rgba(245, 158, 11, 0.15);
        --danger: #EF4444;
        --purple: #A855F7;
        --purple-glow: rgba(168, 85, 247, 0.15);
        --card-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      transition: background 0.2s ease, color 0.2s ease;
      overflow-x: hidden;
      width: 100%;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    button {
      font-family: inherit;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    button:hover { background: var(--surface-hover); border-color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary { background: var(--accent); color: #FFFFFF; border-color: var(--accent); font-weight: 600; }
    body[data-theme="dark"] button.primary { color: #020617; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] button.primary { color: #020617; }
    }
    button.primary:hover:not(:disabled) { opacity: 0.9; }
    button.warning { background: var(--warning); color: #020617; border-color: var(--warning); font-weight: 600; }
    button.sm { padding: 4px 8px; font-size: 11px; }

    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 10px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      gap: 16px;
      flex-wrap: wrap;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .logo { font-size: 15px; font-weight: 700; letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px; }
    .logo-badge { background: var(--accent); color: #FFFFFF; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    body[data-theme="dark"] .logo-badge { color: #020617; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .logo-badge { color: #020617; }
    }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); flex-shrink: 0; }
    .status-text { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

    .header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .view-switcher {
      display: inline-flex;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px;
      gap: 2px;
    }
    .view-btn {
      border: none;
      background: transparent;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .view-btn.active {
      background: var(--surface);
      color: var(--accent);
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .time-selector, .project-selector {
      background: var(--surface-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }

    .container {
      width: 100%;
      max-width: 100%;
      margin: 0;
      padding: 18px 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-sizing: border-box;
    }

    /* Funnel Strip */
    .funnel-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      box-shadow: var(--card-shadow);
      box-sizing: border-box;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .funnel-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      box-sizing: border-box;
    }
    @media (max-width: 1200px) {
      .funnel-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 640px) {
      .funnel-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .funnel-step {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: relative;
      transition: all 0.15s ease;
    }
    .funnel-step:hover { border-color: var(--accent); background: var(--surface-hover); }
    .funnel-step.alert { border-color: var(--warning); background: var(--warning-glow); }
    .step-label { font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; }
    .step-count { font-size: 24px; font-weight: 800; font-family: var(--font-mono); color: var(--text); }
    .step-subtext { font-size: 11px; color: var(--text-muted); }

    /* Active Worktrees List */
    .worktrees-grid { display: flex; flex-direction: column; gap: 14px; }
    .worktree-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: var(--card-shadow);
    }
    .worktree-card.waiting { border-color: var(--warning); box-shadow: 0 0 16px var(--warning-glow); }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .card-meta { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; flex-wrap: wrap; }
    .card-title { font-size: 15px; font-weight: 600; color: var(--text); margin-top: 4px; }

    /* Badges */
    .badge { padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; font-family: var(--font-mono); }
    .badge-orca { background: rgba(14, 165, 233, 0.15); color: #0284C7; border: 1px solid rgba(14, 165, 233, 0.4); }
    body[data-theme="dark"] .badge-orca { color: #38BDF8; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-orca { color: #38BDF8; }
    }
    .badge-claude { background: rgba(217, 119, 6, 0.15); color: #B45309; border: 1px solid rgba(217, 119, 6, 0.3); }
    body[data-theme="dark"] .badge-claude { color: #F59E0B; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-claude { color: #F59E0B; }
    }
    .badge-codex { background: rgba(16, 185, 129, 0.15); color: #059669; border: 1px solid rgba(16, 185, 129, 0.3); }
    body[data-theme="dark"] .badge-codex { color: #10B981; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-codex { color: #10B981; }
    }
    .badge-antigravity { background: rgba(124, 58, 237, 0.15); color: #7C3AED; border: 1px solid rgba(124, 58, 237, 0.3); }
    body[data-theme="dark"] .badge-antigravity { color: #A855F7; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-antigravity { color: #A855F7; }
    }
    .badge-gemini { background: rgba(37, 99, 235, 0.15); color: #2563EB; border: 1px solid rgba(37, 99, 235, 0.3); }
    body[data-theme="dark"] .badge-gemini { color: #60A5FA; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-gemini { color: #60A5FA; }
    }
    .badge-simulator { background: rgba(99, 102, 241, 0.15); color: #4F46E5; border: 1px solid rgba(99, 102, 241, 0.35); }
    body[data-theme="dark"] .badge-simulator { color: #818CF8; }
    @media (prefers-color-scheme: dark) {
      body[data-theme="system"] .badge-simulator { color: #818CF8; }
    }
    .badge-status-running { background: rgba(2, 132, 199, 0.12); color: var(--accent); border: 1px solid var(--accent); }
    .badge-status-assigned { background: var(--surface-hover); color: var(--text-muted); border: 1px solid var(--border); }
    .badge-status-parked { background: rgba(217, 119, 6, 0.15); color: var(--warning); border: 1px solid var(--warning); }
    .badge-status-completed { background: rgba(5, 150, 105, 0.15); color: var(--success); border: 1px solid var(--success); }
    .badge-status-failed { background: rgba(220, 38, 38, 0.15); color: var(--danger); border: 1px solid var(--danger); }
    .badge-status-unknown { background: var(--surface-hover); color: var(--text-dim); border: 1px solid var(--border); }

    .badge-project {
      background: var(--surface-hover);
      color: var(--text-muted);
      border: 1px solid var(--border);
      max-width: 105px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
      vertical-align: middle;
    }
    .badge-prio-1 { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-prio-2 { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-prio-3 { background: var(--surface-hover); color: var(--text-muted); border: 1px solid var(--border); }
    .badge-prio-4 { background: var(--surface-hover); color: var(--text-dim); border: 1px solid var(--border); }
    .badge-waiting { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid var(--warning); }
    .badge-pass { background: rgba(16, 185, 129, 0.2); color: var(--success); border: 1px solid var(--success); }

    /* Agent Roster & Provenance */
    .roster-container {
      margin-top: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    .roster-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 12px;
      background: var(--surface-elevated);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-weight: 600;
      flex-wrap: wrap;
      gap: 6px;
    }
    .roster-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .roster-header-right {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
    }
    .roster-table-wrap {
      overflow-x: auto;
      width: 100%;
      -webkit-overflow-scrolling: touch;
    }
    .roster-table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      font-size: 11px;
    }
    .roster-table .badge {
      display: inline-block;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .roster-table th {
      padding: 6px 10px;
      text-align: left;
      color: var(--text-dim);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .roster-table td {
      padding: 7px 10px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
    }
    .roster-table tr:last-child td {
      border-bottom: none;
    }
    .roster-provenance-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-dim);
      background: var(--surface);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .unverified-liveness-note {
      font-size: 10px;
      color: var(--text-dim);
      font-style: italic;
      margin-top: 2px;
    }

    /* 8 Gates Pipeline Dots */
    .pipeline-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-elevated);
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
      overflow-x: auto;
    }
    .gate-step { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; color: var(--text-muted); flex-shrink: 0; }
    .gate-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--surface-hover);
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .gate-dot.pass { background: var(--success); border-color: var(--success); box-shadow: 0 0 6px var(--success-glow); }
    .gate-dot.fail { background: var(--danger); border-color: var(--danger); }
    .gate-dot.active { background: var(--warning); border-color: var(--warning); box-shadow: 0 0 6px var(--warning-glow); }
    .gate-dot.na { background: var(--surface-hover); border-color: var(--text-dim); }
    .gate-connector { flex: 1; height: 2px; background: var(--border); min-width: 12px; max-width: 28px; }

    /* Roles & Sub-agents */
    .roles-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
    .role-chip {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
    }

    /* Question / Alert box */
    .alert-box {
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(245, 158, 11, 0.35);
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .alert-header { font-weight: 700; color: var(--warning); display: flex; align-items: center; gap: 6px; }
    .alert-text { font-size: 13px; color: var(--text); }
    .alert-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }

    /* Triage Table */
    .triage-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      box-shadow: var(--card-shadow);
    }
    .table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .table th { text-align: left; padding: 10px 12px; color: var(--text-dim); font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
    .table td { padding: 12px; border-bottom: 1px solid var(--border-subtle); }
    .table tr:hover td { background: var(--surface-hover); }

    /* Analytics / Velocity */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      box-shadow: var(--card-shadow);
    }
    .stat-label { font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; }
    .stat-val { font-size: 22px; font-weight: 800; font-family: var(--font-mono); color: var(--text); }

    /* Projects Strip */
    .projects-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .project-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: var(--card-shadow);
      box-sizing: border-box;
    }
    .project-card-title { font-weight: 700; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }

    /* Automations Strip */
    .automations-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    @media (max-width: 1024px) { .automations-grid { grid-template-columns: repeat(1, 1fr); } }
    .automation-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: var(--card-shadow);
      box-sizing: border-box;
    }
    .automation-card-title { font-weight: 700; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }

    /* Kanban Board View */
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      width: 100%;
      align-items: start;
      box-sizing: border-box;
    }
    @media (max-width: 1200px) {
      .kanban-board {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
    }
    @media (max-width: 720px) {
      .kanban-board {
        grid-template-columns: repeat(1, minmax(0, 1fr));
        gap: 12px;
      }
    }
    .kanban-col {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 480px;
      min-width: 0;
      box-shadow: var(--card-shadow);
      box-sizing: border-box;
    }
    .kanban-col-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-subtle);
      gap: 6px;
    }
    .kanban-col-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.3px;
    }
    .kanban-col-badge {
      background: var(--surface-elevated);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .kanban-cards {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .kanban-card {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      transition: all 0.15s ease;
      word-break: break-word;
      box-sizing: border-box;
    }
    .kanban-card:hover {
      border-color: var(--accent);
      background: var(--surface-hover);
      transform: translateY(-1px);
    }
    .kanban-card.waiting {
      border-color: var(--warning);
      background: rgba(245, 158, 11, 0.05);
    }
    .kanban-card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.35;
      word-break: break-word;
    }
    .kanban-card-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 4px;
      font-size: 11px;
      color: var(--text-dim);
      font-family: var(--font-mono);
    }

    /* Modal System */
    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(4px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 580px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: modalSlide 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalSlide {
      from { opacity: 0; transform: translateY(12px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-title { font-size: 15px; font-weight: 700; color: var(--text); }
    .modal-close {
      background: transparent;
      border: none;
      font-size: 18px;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
    }
    .modal-close:hover { color: var(--text); }
    .modal-body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .modal-prompt-box {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      max-height: 180px;
      overflow-y: auto;
    }
    .modal-label { font-size: 12px; font-weight: 600; color: var(--text); }
    .modal-textarea {
      width: 100%;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 6px;
      outline: none;
      resize: vertical;
    }
    .modal-textarea:focus { border-color: var(--accent); }
    .quick-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .chip-label { font-size: 11px; color: var(--text-dim); }
    .chip {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      color: var(--text-muted);
    }
    .chip:hover { border-color: var(--accent); color: var(--text); }
    .modal-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border);
      background: var(--surface-elevated);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    /* Toast Notification System */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 2000;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--text);
      min-width: 280px;
      max-width: 440px;
      animation: toastIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      transition: all 0.2s ease;
    }
    @keyframes toastIn {
      from { opacity: 0; transform: translateY(12px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .toast.success { border-color: var(--success); }
    .toast.success .toast-icon { color: var(--success); font-weight: 800; }
    .toast.error { border-color: var(--danger); }
    .toast.error .toast-icon { color: var(--danger); font-weight: 800; }
    .toast.info { border-color: var(--accent); }
    .issue-link {
      color: var(--accent);
      text-decoration: none;
      font-family: var(--font-mono);
      font-weight: 700;
      transition: color 0.15s ease, filter 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .issue-link:hover {
      text-decoration: underline;
      filter: brightness(1.2);
    }
    .kanban-card-title-link {
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      transition: color 0.15s ease;
    }
    .kanban-card-title-link:hover {
      color: var(--accent);
      text-decoration: underline;
    }
    .hover-underline {
      transition: color 0.15s ease, text-decoration 0.15s ease;
    }
    .hover-underline:hover {
      text-decoration: underline !important;
      color: var(--accent) !important;
    }

    .empty-state { text-align: center; padding: 32px; color: var(--text-dim); font-size: 13px; }
  </style>
</head>
<body data-theme="light">
  <div class="header">
    <div class="header-left">
      <div class="logo">
        <span class="logo-badge">Wingmate</span>
        <span>Architect Command Center</span>
        <span style="font-size: 11px; font-weight: normal; color: var(--text-dim); margin-left: 4px;">Project agents and routines · Powered by Orca</span>
      </div>
      <div class="pulse-dot" id="pulseDot"></div>
      <div class="status-text" id="statusSummary">Connecting to local dispatcher...</div>
    </div>
    <div class="header-right">
      <!-- View Switcher -->
      <div class="view-switcher">
        <button id="btnViewPipeline" class="view-btn active" onclick="switchView('pipeline')">
          ≡ Funnel View
        </button>
        <button id="btnViewKanban" class="view-btn" onclick="switchView('kanban')">
          ☷ Kanban Board
        </button>
      </div>

      <!-- Scope & Time Filters -->
      <select id="projectSelect" class="project-selector" onchange="fetchData()">
        <option value="">All Projects</option>
      </select>
      <select id="timeframeSelect" class="time-selector" onchange="fetchData()">
        <option value="today">Today</option>
        <option value="7d" selected>Last 7 Days</option>
        <option value="30d">Last 30 Days</option>
        <option value="all">All Time</option>
      </select>

      <!-- Theme Switcher (Light · Dark · System) -->
      <button id="themeToggleBtn" onclick="cycleTheme()" class="sm" title="Switch Theme (Light · Dark · System)">
        <span id="themeIcon">☀️</span> <span id="themeText">Light</span>
      </button>

      <!-- Actions -->
      <button onclick="toggleDispatcherPause()" id="pauseBtn" class="sm">Pause Dispatcher</button>
      <button id="refreshBtn" onclick="manualRefresh()" class="sm">↻ Refresh</button>
    </div>
  </div>

  <div class="container">
    <!-- VIEW 1: Pipeline Funnel View -->
    <div id="pipelineView" style="display: flex; flex-direction: column; gap: 24px;">
      <!-- 1. Pipeline Funnel Strip -->
      <div class="funnel-container">
        <div class="section-title">
          <span>Lifecycle Pipeline Funnel (Linear ➔ Worktrees ➔ PR ➔ Done)</span>
          <span id="funnelMeta" style="font-size: 11px; font-weight: normal; color: var(--text-dim);">Live Sync</span>
        </div>
        <div class="funnel-grid" id="funnelGrid">
          <!-- Injected via JS -->
        </div>
      </div>

      <!-- 2. Active In-Flight Worktrees & Agents -->
      <div>
        <div class="section-title">
          <span>Active In-Flight Worktrees & Agents</span>
          <span id="activeCount" style="color: var(--accent); font-family: var(--font-mono);">0 Active</span>
        </div>
        <div class="worktrees-grid" id="worktreesList">
          <!-- Injected via JS -->
        </div>
      </div>

      <!-- 3. Architect Triage & Launchpad -->
      <div class="triage-container">
        <div class="section-title">
          <span>Architect Triage & Launchpad (Linear Backlog / Todo ➔ Promote to Agent-Ready)</span>
          <span id="triageCount" style="color: var(--accent); font-family: var(--font-mono);">0 Candidates</span>
        </div>
        <div id="triageContent">
          <!-- Injected via JS -->
        </div>
      </div>

      <!-- 4. Pipeline Velocity & Cost Metrics -->
      <div>
        <div class="section-title">
          <span>Pipeline Velocity & Historical Throughput</span>
          <span id="metricsPeriod" style="color: var(--text-dim); font-size: 11px;">7 Days</span>
        </div>
        <div class="stats-grid" id="statsGrid">
          <!-- Injected via JS -->
        </div>
      </div>

      <!-- 5. Active Pilot Projects & Worktree Allocation -->
      <div>
        <div class="section-title">
          <span>Projects & Worktree Allocation</span>
        </div>
        <div class="projects-grid" id="projectsGrid">
          <!-- Injected via JS -->
        </div>
      </div>

      <!-- 6. Native Agent Harness Automations & Routines -->
      <div>
        <div class="section-title">
          <span>Automations & Routine Evidence</span>
          <span style="font-size: 11px; font-weight: normal; color: var(--text-dim);">Orca ADE · Claude Code · OpenAI Codex</span>
        </div>
        <div class="automations-grid" id="automationsGrid">
          <!-- Injected via JS -->
        </div>
      </div>
    </div>

    <!-- VIEW 2: Kanban Style Board View -->
    <div id="kanbanView" style="display: none; flex-direction: column; gap: 14px;">
      <div class="section-title">
        <span>Architect Pipeline Board</span>
        <span id="kanbanMeta" style="font-size: 11px; font-weight: normal; color: var(--text-dim);">6 Lifecycle Stages</span>
      </div>
      <div class="kanban-board" id="kanbanBoard">
        <!-- Injected via JS -->
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div id="toastContainer" class="toast-container"></div>

  <script>
    let currentData = null;
    let currentTheme = localStorage.getItem("wingmate_theme") || "light";
    let currentView = localStorage.getItem("wingmate_view") || "pipeline";
    let pollTimer = null;

    function updateThemeUI(theme) {
      const icon = document.getElementById("themeIcon");
      const text = document.getElementById("themeText");
      if (!icon || !text) return;
      if (theme === "dark") {
        icon.textContent = "🌙";
        text.textContent = "Dark";
      } else if (theme === "system") {
        icon.textContent = "💻";
        text.textContent = "System";
      } else {
        icon.textContent = "☀️";
        text.textContent = "Light";
      }
    }

    function applyTheme(theme) {
      const valid = theme === "dark" || theme === "system" ? theme : "light";
      currentTheme = valid;
      document.body.setAttribute("data-theme", valid);
      localStorage.setItem("wingmate_theme", valid);
      updateThemeUI(valid);
    }

    function cycleTheme() {
      const nextTheme = currentTheme === "light" ? "dark" : currentTheme === "dark" ? "system" : "light";
      applyTheme(nextTheme);
    }

    function toggleTheme() {
      cycleTheme();
    }

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (currentTheme === "system") {
          applyTheme("system");
        }
      });
    }

    function switchView(view) {
      currentView = view;
      localStorage.setItem("wingmate_view", view);
      const pView = document.getElementById("pipelineView");
      const kView = document.getElementById("kanbanView");
      const btnP = document.getElementById("btnViewPipeline");
      const btnK = document.getElementById("btnViewKanban");

      if (view === "kanban") {
        pView.style.display = "none";
        kView.style.display = "flex";
        btnP.classList.remove("active");
        btnK.classList.add("active");
        if (currentData) renderKanban(currentData);
      } else {
        pView.style.display = "flex";
        kView.style.display = "none";
        btnP.classList.add("active");
        btnK.classList.remove("active");
      }
    }

    function showToast(msg, type) {
      const t = type || "success";
      const container = document.getElementById("toastContainer");
      const toast = document.createElement("div");
      toast.className = "toast " + t;
      const icon = t === "success" ? "✓" : t === "error" ? "✕" : "ℹ";
      toast.innerHTML = '<span class="toast-icon">' + icon + '</span><span style="flex:1;">' + escapeHtml(msg) + '</span><button class="modal-close" style="font-size:14px;" onclick="this.parentElement.remove()">✕</button>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
        setTimeout(() => toast.remove(), 200);
      }, 4000);
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    async function fetchData() {
      const projSelect = document.getElementById("projectSelect");
      const tfSelect = document.getElementById("timeframeSelect");
      const proj = projSelect ? projSelect.value : "";
      const tf = tfSelect ? tfSelect.value : "7d";
      const url = "/api/snapshot?timeframe=" + tf + (proj ? "&project=" + encodeURIComponent(proj) : "");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("HTTP " + res.status);
        currentData = await res.json();
        renderAll(currentData);
        return currentData;
      } catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === "AbortError" ? "Request timed out" : err.message;
        const summary = document.getElementById("statusSummary");
        if (summary) summary.textContent = "Error loading data: " + msg;
        const dot = document.getElementById("pulseDot");
        if (dot) dot.style.background = "var(--danger)";
        throw err;
      }
    }

    async function manualRefresh() {
      const btn = document.getElementById("refreshBtn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "↻ Refreshing...";
      }
      try {
        await fetchData();
        showToast("✓ Dashboard refreshed", "info");
      } catch (err) {
        showToast("Refresh error: " + err.message, "error");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "↻ Refresh";
        }
      }
    }

    function renderAll(d) {
      renderHeader(d);
      renderFunnel(d.funnel);
      renderWorktrees(d.activeWorktrees);
      renderTriage(d.triage);
      renderMetrics(d.metrics);
      renderProjects(d.projects, d.automations);
      if (currentView === "kanban") {
        renderKanban(d);
      }
    }

    function renderHeader(d) {
      const hb = d.dispatcher;
      const isPaused = (d.pausedScopes || []).length > 0;
      const dot = document.getElementById("pulseDot");
      const summary = document.getElementById("statusSummary");
      const pBtn = document.getElementById("pauseBtn");

      if (isPaused) {
        dot.style.background = "var(--warning)";
        summary.textContent = "Dispatcher Paused (" + d.pausedScopes.join(", ") + ")";
        pBtn.textContent = "Resume Dispatcher";
        pBtn.className = "warning sm";
      } else if (hb) {
        dot.style.background = "var(--success)";
        const dur = hb.durationMs ? hb.durationMs + "ms" : "";
        summary.textContent = "Dispatcher " + hb.outcome + " · last tick " + dur + " · exit " + hb.exitCode;
        pBtn.textContent = "Pause Dispatcher";
        pBtn.className = "sm";
      }
    }

    function renderFunnel(f) {
      const el = document.getElementById("funnelGrid");
      if (!f) return;

      el.innerHTML = [
        '<div class="funnel-step">',
          '<div class="step-label">1. Todo / Backlog</div>',
          '<div class="step-count">' + f.todo + '</div>',
          '<div class="step-subtext">Unassigned Linear issues</div>',
        '</div>',
        '<div class="funnel-step">',
          '<div class="step-label">2. Agent-Ready</div>',
          '<div class="step-count">' + f.agentReady + '</div>',
          '<div class="step-subtext">Queued for pickup</div>',
        '</div>',
        '<div class="funnel-step">',
          '<div class="step-label">3. In Worktree</div>',
          '<div class="step-count" style="color: var(--accent);">' + f.inAgent + '</div>',
          '<div class="step-subtext">Autonomous coding</div>',
        '</div>',
        '<div class="funnel-step ' + (f.waitingOnHuman > 0 ? 'alert' : '') + '">',
          '<div class="step-label">4. Waiting on You</div>',
          '<div class="step-count" style="color: ' + (f.waitingOnHuman > 0 ? 'var(--warning)' : 'var(--text)') + ';">' + f.waitingOnHuman + '</div>',
          '<div class="step-subtext">Needs approval / answer</div>',
        '</div>',
        '<div class="funnel-step">',
          '<div class="step-label">5. Review / PR</div>',
          '<div class="step-count">' + f.reviewReady + '</div>',
          '<div class="step-subtext">Implementation done</div>',
        '</div>',
        '<div class="funnel-step">',
          '<div class="step-label">6. Done / Merged</div>',
          '<div class="step-count" style="color: var(--success);">' + f.done + '</div>',
          '<div class="step-subtext">In selected timeframe</div>',
        '</div>'
      ].join("");
    }

    function renderWorktrees(wts) {
      const el = document.getElementById("worktreesList");
      document.getElementById("activeCount").textContent = (wts || []).length + " Active";

      if (!wts || wts.length === 0) {
        el.innerHTML = '<div class="empty-state">No agents currently running. Promote a Linear issue to <code>agent-ready</code> to launch an autonomous worktree.</div>';
        return;
      }

      el.innerHTML = wts.map(w => {
        const isWaiting = w.stage === "awaiting-human" || !!w.openQuestion;
        const gateKeys = ["intake", "plan", "planVerify", "implement", "validate", "ui", "security", "pr"];

        const gateDots = gateKeys.map((k, idx) => {
          const g = w.gates[k];
          let statusClass = "";
          if (g && g.verdict === "PASS") statusClass = "pass";
          else if (g && g.verdict === "FAIL") statusClass = "fail";
          else if (g && g.verdict === "NA") statusClass = "na";
          else if (w.pipelineStage === k) statusClass = "active";

          return (
            '<div class="gate-step" title="' + k + ': ' + (g ? g.verdict || 'pending' : 'pending') + '">' +
              '<div class="gate-dot ' + statusClass + '"></div>' +
              '<span>' + k + '</span>' +
            '</div>' +
            (idx < gateKeys.length - 1 ? '<div class="gate-connector"></div>' : '')
          );
        }).join("");

        const rolesHtml = (w.roleJobs || []).map(r => (
          '<div class="role-chip">' +
            '<span style="color: var(--purple); font-weight: 700;">' + r.role + '</span>' +
            '<span>' + r.provider + '</span>' +
            '<span style="color: ' + (r.verdict === 'PASS' ? 'var(--success)' : r.verdict === 'FAIL' ? 'var(--danger)' : 'var(--warning)') + '; font-weight: 700;">' + (r.verdict || r.status) + '</span>' +
          '</div>'
        )).join("");

        let questionHtml = '';
        if (isWaiting && w.openQuestion) {
          questionHtml = (
            '<div class="alert-box" id="box-' + w.identifier + '">' +
              '<div class="alert-header"><span>⚠️ Waiting on Your Input / Plan Approval</span></div>' +
              '<div class="alert-text">' + escapeHtml(w.openQuestion.prompt || "The agent has asked a clarification or plan approval question before proceeding.") + '</div>' +
              '<div class="alert-actions">' +
                answerInLinearLink(w) +
              '</div>' +
            '</div>'
          );
        }

        const rosterEntries = w.roster || [];
        const rosterCount = rosterEntries.length;
        const summary = w.rosterSummary || { total: rosterCount, running: 0, assigned: 0, parked: 0, completed: 0, failed: 0, unknown: 0 };

        const rosterRowsHtml = rosterEntries.map(a => {
          const roleIcon = a.role === 'coordinator' ? '👑' : a.role.includes('review') ? '🔍' : a.role.includes('verifier') ? '🛡️' : a.role.includes('ui') ? '📱' : '⚙️';
          const roleDisplay = a.role === 'coordinator' ? 'Coordinator' : a.role;
          const statusBadge = '<span class="badge badge-status-' + escapeHtml(a.assignedStatus) + '" title="' + escapeHtml(a.provenanceDetail) + '">' + escapeHtml(a.statusDetail || a.assignedStatus) + '</span>';
          const providerBadge = '<span class="badge badge-' + escapeHtml(a.provider) + '">' + escapeHtml(a.provider) + (a.model ? ' · ' + escapeHtml(a.model) : '') + '</span>';
          
          return (
            '<tr>' +
              '<td>' +
                '<strong>' + roleIcon + ' ' + escapeHtml(roleDisplay) + '</strong>' +
                (a.terminalHandle ? '<div style="font-size:10px; color:var(--text-dim); font-family:var(--font-mono);">' + escapeHtml(a.terminalHandle.slice(0, 18)) + '</div>' : '') +
              '</td>' +
              '<td>' + providerBadge + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td>' +
                '<div style="font-weight: 500;">' + escapeHtml(a.currentAction) + '</div>' +
                '<div class="unverified-liveness-note">Evidence: ' + escapeHtml(a.provenanceDetail) + '</div>' +
              '</td>' +
              '<td>' +
                (a.branch ? '<div style="font-family: var(--font-mono); font-size: 10px; color: var(--text-dim);">🌿 ' + escapeHtml(a.branch) + '</div>' : '') +
                (a.worktreePath ? '<button class="sm btn-open-orca" data-path="' + escapeHtml(a.worktreePath) + '" style="padding:2px 6px; font-size:10px; margin-top:2px;" title="Open ' + escapeHtml(a.worktreePath) + ' in Editor">Worktree ↗</button>' : '') +
              '</td>' +
            '</tr>'
          );
        }).join("");

        const rosterHtml = (
          '<div class="roster-container">' +
            '<div class="roster-header">' +
              '<div class="roster-header-left">' +
                '<span>👥 Agent Roster: <strong>' + rosterCount + ' assigned</strong></span>' +
                '<span class="badge" style="background:var(--surface-hover); color:var(--text-muted);">' +
                  summary.running + ' working · ' + summary.assigned + ' queued · ' + summary.parked + ' parked' +
                  (summary.completed > 0 ? ' · ' + summary.completed + ' done' : '') +
                  (summary.failed > 0 ? ' · ' + summary.failed + ' failed' : '') +
                  (summary.unknown > 0 ? ' · ' + summary.unknown + ' unknown' : '') +
                '</span>' +
              '</div>' +
              '<div class="roster-header-right">' +
                '<span class="roster-provenance-tag" title="Recorded assignments; live process status has not been checked.">' +
                  '📋 Recorded assignments · live status unverified' +
                '</span>' +
              '</div>' +
            '</div>' +
            '<div class="roster-table-wrap">' +
              '<table class="roster-table">' +
                '<thead>' +
                  '<tr>' +
                    '<th style="width: 150px;">Agent Role</th>' +
                    '<th style="width: 125px;">Provider</th>' +
                    '<th style="width: 140px;">Status</th>' +
                    '<th>Recorded Role / Stage</th>' +
                    '<th style="width: 160px;">Worktree / Ref</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody>' +
                  (rosterRowsHtml || '<tr><td colspan="5" style="text-align:center; color:var(--text-dim);">No agent jobs recorded</td></tr>') +
                '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>'
        );

        let executionTasksHtml = "";
        const execTasks = w.executionTasks || [];
        if (execTasks.length > 0) {
          const taskRowsHtml = execTasks.map(t => {
            const statusClass = t.status === "completed" ? "badge-status-completed" : t.status === "running" ? "badge-status-running" : t.status === "failed" ? "badge-status-failed" : "badge-status-unknown";
            return (
              '<tr>' +
                '<td><strong>📱 ' + escapeHtml(t.device) + '</strong></td>' +
                '<td><span class="badge badge-simulator">Simulator</span></td>' +
                '<td><span class="badge ' + statusClass + '">' + escapeHtml(t.statusDetail) + '</span></td>' +
                '<td>' + escapeHtml(t.recordedAction) + '</td>' +
                '<td><span style="font-family:var(--font-mono); font-size:10px; color:var(--text-dim);">' + escapeHtml(t.id.slice(0, 16)) + '</span></td>' +
              '</tr>'
            );
          }).join("");

          executionTasksHtml = (
            '<div class="execution-tasks-container" style="margin-top: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden;">' +
              '<div class="execution-tasks-header" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: var(--surface-elevated); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 600;">' +
                '<span>🧪 Native UI Test Tasks: <strong>' + execTasks.length + ' recorded</strong></span>' +
                '<span class="roster-provenance-tag">Native Simulator</span>' +
              '</div>' +
              '<div class="roster-table-wrap">' +
                '<table class="roster-table">' +
                  '<thead>' +
                    '<tr>' +
                      '<th style="width: 150px;">Target</th>' +
                      '<th style="width: 125px;">Type</th>' +
                      '<th style="width: 140px;">Status</th>' +
                      '<th>Recorded Task Status</th>' +
                      '<th style="width: 160px;">Task ID</th>' +
                    '</tr>' +
                  '</thead>' +
                  '<tbody>' +
                    taskRowsHtml +
                  '</tbody>' +
                '</table>' +
              '</div>' +
            '</div>'
          );
        }

        return (
          '<div class="worktree-card ' + (isWaiting ? 'waiting' : '') + '" id="wt-' + w.identifier + '">' +
            '<div class="card-header">' +
              '<div>' +
                '<div class="card-meta">' +
                  '<span class="badge badge-project">' + escapeHtml(w.project) + '</span>' +
                  '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(w.identifier) + ' in Linear"><strong>' + escapeHtml(w.identifier) + ' ↗</strong></a>' +
                  '<span class="badge badge-' + escapeHtml(w.provider) + '">' + escapeHtml(w.provider) + (w.model ? ' · ' + escapeHtml(w.model) : '') + '</span>' +
                  '<span style="color: var(--text-dim);">Claim age: ' + w.ageMin + 'm</span>' +
                  (w.worktreePath ? '<span style="color: var(--text-dim); font-family: var(--font-mono);">' + escapeHtml(w.worktreePath.split("/").slice(-2).join("/")) + '</span>' : '') +
                '</div>' +
                '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" style="color: var(--text); text-decoration: none;" class="hover-underline"><div class="card-title">' + escapeHtml(w.title) + '</div></a>' +
              '</div>' +
              '<div style="display: flex; gap: 8px; align-items: center;">' +
                '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                (w.prUrl ? '<a href="' + escapeHtml(w.prUrl) + '" target="_blank" rel="noopener noreferrer"><button class="sm primary">View PR ↗</button></a>' : '') +
                '<button class="sm btn-open-orca" data-path="' + escapeHtml(w.worktreePath || '') + '" title="Open Worktree in Orca / Editor">Worktree ↗</button>' +
              '</div>' +
            '</div>' +
            '<div class="pipeline-bar">' + gateDots + '</div>' +
            rosterHtml +
            executionTasksHtml +
            questionHtml +
          '</div>'
        );
      }).join("");
    }

    function renderTriage(triage) {
      const cnt = document.getElementById("triageCount");
      const c = document.getElementById("triageContent");
      cnt.textContent = (triage || []).length + " Candidates";

      if (!triage || triage.length === 0) {
        c.innerHTML = '<div class="empty-state">All Linear Todo issues currently have agent labels assigned. New issues created in Linear will appear here.</div>';
        return;
      }

      c.innerHTML = (
        '<table class="table">' +
          '<thead>' +
            '<tr>' +
              '<th>Issue</th>' +
              '<th>Project</th>' +
              '<th>Linear Title</th>' +
              '<th>Recommended Provider</th>' +
              '<th>Priority</th>' +
              '<th style="text-align: right;">Action</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            triage.map(t => {
              const proj = t.project || t.projectKey || "general";
              const prioText = t.priority && t.priority > 0 ? ("P" + t.priority) : "—";
              const prioClass = t.priority && t.priority > 0 ? ("badge-prio-" + t.priority) : "";
              return (
                "<tr>" +
                  '<td><a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(t.identifier) + ' in Linear"><strong>' + escapeHtml(t.identifier) + ' ↗</strong></a></td>' +
                  '<td><span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + "</span></td>" +
                  '<td><a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--text); text-decoration:none;" class="hover-underline">' + escapeHtml(t.title) + "</a></td>" +
                  '<td><span class="badge badge-' + escapeHtml(t.recommendedProvider) + '">' + escapeHtml(t.recommendedProvider) + "</span></td>" +
                  "<td>" + (prioClass ? '<span class="badge ' + prioClass + '">' + prioText + "</span>" : '<span style="color: var(--text-dim);">' + prioText + "</span>") + "</td>" +
                  '<td style="text-align: right;">' +
                    '<div style="display:inline-flex; gap:6px; align-items:center;">' +
                      '<a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                      '<button class="primary sm btn-promote" data-linear-id="' + t.linearId + '" data-id="' + t.identifier + '" data-provider="' + t.recommendedProvider + '">+ Make Agent-Ready</button>' +
                    '</div>' +
                  "</td>" +
                "</tr>"
              );
            }).join("") +
          '</tbody>' +
        '</table>'
      );
    }

    function renderMetrics(m) {
      const g = document.getElementById("statsGrid");
      if (!m) return;
      document.getElementById("metricsPeriod").textContent = m.timeframe.toUpperCase();

      g.innerHTML = [
        '<div class="stat-card">',
          '<div class="stat-label">Issues Completed</div>',
          '<div class="stat-val" style="color: var(--success);">' + m.completedCount + '</div>',
          '<div class="step-subtext">' + m.inProgressCount + ' currently in-agent</div>',
        '</div>',
        '<div class="stat-card">',
          '<div class="stat-label">Avg Cycle Time</div>',
          '<div class="stat-val">' + m.avgCycleMinutes + 'm</div>',
          '<div class="step-subtext">Claim ➔ PR Shipped</div>',
        '</div>',
        '<div class="stat-card">',
          '<div class="stat-label">Gate Pass Rate</div>',
          '<div class="stat-val" style="color: var(--accent);">' + m.gatePassRate + '%</div>',
          '<div class="step-subtext">8-Gate compliance</div>',
        '</div>',
        '<div class="stat-card">',
          '<div class="stat-label">Token Consumption</div>',
          '<div class="stat-val">' + (m.tokens / 1000).toFixed(1) + 'k</div>',
          '<div class="step-subtext">' + (m.costUsd > 0 ? '$' + m.costUsd.toFixed(2) : 'Included in Tier') + '</div>',
        '</div>'
      ].join("");
    }

    function renderProjects(projects, automations) {
      const projectSelect = document.getElementById("projectSelect");
      // An unfiltered snapshot contains the current configured project inventory.
      if (projectSelect && !projectSelect.value) {
        projectSelect.innerHTML = '<option value="">All Projects</option>' + (projects || []).map(p =>
          '<option value="' + escapeHtml(p.key) + '">' + escapeHtml(p.name) + '</option>'
        ).join("");
      }
      const g = document.getElementById("projectsGrid");
      if (g && projects) {
        g.innerHTML = projects.map(p => (
          '<div class="project-card">' +
            '<div class="project-card-title">' +
              '<a href="' + escapeHtml(p.linearProjectUrl || 'https://linear.app') + '" target="_blank" rel="noopener noreferrer" style="color:var(--text); text-decoration:none; display:flex; justify-content:space-between; align-items:center; width:100%;" class="hover-underline" title="Open Linear Project">' +
                '<span>' + escapeHtml(p.name) + '</span>' +
                '<span class="badge badge-project">' + escapeHtml(p.key) + ' ↗</span>' +
              '</a>' +
            '</div>' +
            '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">' +
              '<span>Active Worktrees:</span>' +
              '<strong style="color: ' + (p.activeCount > 0 ? 'var(--accent)' : 'var(--text-dim)') + ';">' + p.activeCount + '</strong>' +
            '</div>' +
            '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">' +
              '<span>Queued / Ready:</span>' +
              '<strong>' + p.queuedCount + '</strong>' +
            '</div>' +
            '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">' +
              '<span>Completed:</span>' +
              '<strong style="color: var(--success);">' + p.completedCount + '</strong>' +
            '</div>' +
            '<div style="font-size: 11px; color: var(--text-dim); border-top: 1px solid var(--border-subtle); padding-top: 6px; margin-top: 4px; display: flex; justify-content: space-between;">' +
              '<span>Slot: ' + (p.slotHeldBy ? '<span style="color: var(--warning);">Held by ' + escapeHtml(p.slotHeldBy) + '</span>' : '<span style="color: var(--success);">Available</span>') + '</span>' +
              (p.automation ? '<span title="' + escapeHtml(p.automation.provenance || '') + '">Auto: <strong>' + escapeHtml(p.automation.cadence) + '</strong></span>' : '') +
            '</div>' +
          '</div>'
        )).join("");
      }

      const autoGrid = document.getElementById("automationsGrid");
      if (autoGrid && automations) {
        autoGrid.innerHTML = automations.map(a => {
          const badgeClass = a.harness === "orca" ? "badge-orca" : a.harness === "claude-code" ? "badge-claude" : a.harness === "codex" ? "badge-codex" : "badge-project";
          const harnessLabel = a.harness === "orca" ? "Orca Automation" : a.harness === "claude-code" ? "Claude Routine" : a.harness === "codex" ? "Codex Scheduled" : a.harness;
          const statusColor = "var(--text-muted)";
          return (
            '<div class="automation-card">' +
              '<div class="automation-card-title">' +
                '<span style="font-weight: 700; font-size: 13px;">' + escapeHtml(a.name) + '</span>' +
                '<span class="badge ' + badgeClass + '">' + escapeHtml(harnessLabel) + '</span>' +
              '</div>' +
              '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">' +
                '<span>Target Scope:</span>' +
                '<strong>' + escapeHtml(a.targetProject) + '</strong>' +
              '</div>' +
              '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">' +
                '<span>Schedule / Trigger:</span>' +
                '<span style="font-family: var(--font-mono); font-size: 11px;">' + escapeHtml(a.schedule) + '</span>' +
              '</div>' +
              '<div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center;">' +
                '<span>Status:</span>' +
                '<span style="font-weight: 600; color: ' + statusColor + ';">' + escapeHtml(a.lastRunStatus) + '</span>' +
              '</div>' +
              '<div style="font-size: 11px; color: var(--text-dim); border-top: 1px solid var(--border-subtle); padding-top: 6px; margin-top: 4px; display: flex; justify-content: space-between;">' +
                '<span>Last Recorded Tick:</span>' +
                '<span>' + (a.lastRunAt ? escapeHtml(new Date(a.lastRunAt).toLocaleString()) : 'No run evidence') + '</span>' +
              '</div>' +
              (a.provenance ? '<div style="font-size: 10px; color: var(--text-dim); font-family: var(--font-mono); margin-top: 4px;">Provenance: ' + escapeHtml(a.provenance) + '</div>' : '') +
            '</div>'
          );
        }).join("");
      }
    }

    function renderKanban(d) {
      const board = document.getElementById("kanbanBoard");
      if (!board || !d) return;

      const active = d.activeWorktrees || [];
      const triage = d.triage || [];
      const waiting = active.filter(w => w.stage === "awaiting-human" || !!w.openQuestion);
      const inAgent = active.filter(w => !waiting.includes(w) && w.stage !== "review" && w.pipelineStage !== "pr");
      const inReview = active.filter(w => w.stage === "review" || w.pipelineStage === "pr");

      board.innerHTML = (
        '<!-- Col 1: Todo / Backlog -->' +
        '<div class="kanban-col">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title">Todo / Backlog</span>' +
            '<span class="kanban-col-badge">' + triage.length + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            (triage.length === 0 ? '<div class="empty-state" style="padding:16px;">No candidate issues</div>' : triage.map(t => {
              const proj = t.project || t.projectKey || "general";
              const prioText = t.priority && t.priority > 0 ? ("P" + t.priority) : "";
              const prioHtml = prioText ? ('<span class="badge badge-prio-' + t.priority + '">' + prioText + '</span>') : "";
              return (
                '<div class="kanban-card">' +
                  '<div class="kanban-card-meta">' +
                    '<span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</span>' +
                    '<a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(t.identifier) + ' in Linear"><strong>' + escapeHtml(t.identifier) + ' ↗</strong></a>' +
                    prioHtml +
                  '</div>' +
                  '<a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer" class="kanban-card-title-link" title="Open in Linear">' + escapeHtml(t.title) + '</a>' +
                  '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">' +
                    '<span class="badge badge-' + escapeHtml(t.recommendedProvider) + '">' + escapeHtml(t.recommendedProvider) + '</span>' +
                    '<div style="display:flex; gap:4px; align-items:center;">' +
                      '<a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                      '<button class="primary sm btn-promote" data-linear-id="' + t.linearId + '" data-id="' + t.identifier + '" data-provider="' + t.recommendedProvider + '">+ Ready</button>' +
                    '</div>' +
                  '</div>' +
                '</div>'
              );
            }).join("")) +
          '</div>' +
        '</div>' +

        '<!-- Col 2: Agent-Ready (Queued) -->' +
        '<div class="kanban-col">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title">Agent-Ready</span>' +
            '<span class="kanban-col-badge">' + d.funnel.agentReady + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            ((d.queue && d.queue.length > 0) ? d.queue.map(q => {
              const proj = q.project || "general";
              const qUrl = q.linearUrl || ("https://linear.app/issue/" + q.identifier);
              return (
                '<div class="kanban-card">' +
                  '<div class="kanban-card-meta">' +
                    '<span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</span>' +
                    '<a href="' + escapeHtml(qUrl) + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(q.identifier) + ' in Linear"><strong>' + escapeHtml(q.identifier) + ' ↗</strong></a>' +
                    '<span class="badge badge-' + escapeHtml(q.provider || 'agent') + '">' + escapeHtml(q.provider || 'ready') + '</span>' +
                  '</div>' +
                  '<a href="' + escapeHtml(qUrl) + '" target="_blank" rel="noopener noreferrer" class="kanban-card-title-link" title="Open in Linear">' + escapeHtml(q.title || "Queued Linear Issue") + '</a>' +
                  '<div style="font-size:11px; color:var(--text-dim); display:flex; justify-content:space-between; align-items:center; margin-top:6px;">' +
                    '<span>Status: <strong style="color:var(--accent);">Queued</strong></span>' +
                    '<a href="' + escapeHtml(qUrl) + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                  '</div>' +
                '</div>'
              );
            }).join("") : (d.funnel.agentReady > 0 ? (
              '<div class="kanban-card" style="background:rgba(56, 189, 248, 0.05); border-color:var(--accent); text-align:center; padding:14px;">' +
                '<div style="font-weight:700; color:var(--accent); margin-bottom:4px;">' + d.funnel.agentReady + ' issue' + (d.funnel.agentReady > 1 ? 's' : '') + ' ready</div>' +
                '<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Marked agent-ready in Linear.<br>Awaiting dispatcher claim.</div>' +
                '<a href="https://linear.app" target="_blank" rel="noopener noreferrer"><button class="sm" style="width:100%;">View Queue in Linear ↗</button></a>' +
              '</div>'
            ) : '<div class="empty-state" style="padding:16px;">Queue is empty. Promote an issue from Todo to queue.</div>')) +
          '</div>' +
        '</div>' +

        '<!-- Col 3: In Worktree (In-Agent) -->' +
        '<div class="kanban-col">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title" style="color: var(--accent);">In Worktree</span>' +
            '<span class="kanban-col-badge">' + inAgent.length + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            (inAgent.length === 0 ? '<div class="empty-state" style="padding:16px;">No agents actively coding</div>' : inAgent.map(w => {
              const proj = w.project || "general";
              const rosterSnippet = (w.roster && w.roster.length > 0) ? (
                '<div style="font-size:10px; color:var(--text-muted); background:var(--surface); border:1px solid var(--border-subtle); border-radius:4px; padding:3px 6px; margin-top:4px;">' +
                  '<span><strong>' + w.roster.length + ' Agent' + (w.roster.length > 1 ? 's' : '') + ':</strong> ' +
                  w.roster.map(a => (a.role === 'coordinator' ? '👑 ' : '⚙️ ') + escapeHtml(a.provider) + ' (' + escapeHtml(a.role) + ': ' + escapeHtml(a.assignedStatus) + ')').join(', ') +
                  '</span>' +
                '</div>'
              ) : '';
              return (
                '<div class="kanban-card">' +
                  '<div class="kanban-card-meta">' +
                    '<span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</span>' +
                    '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(w.identifier) + ' in Linear"><strong>' + escapeHtml(w.identifier) + ' ↗</strong></a>' +
                    '<span class="badge badge-' + escapeHtml(w.provider) + '">' + escapeHtml(w.provider) + '</span>' +
                  '</div>' +
                  '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="kanban-card-title-link" title="Open in Linear">' + escapeHtml(w.title) + '</a>' +
                  '<div style="font-size:11px; color:var(--text-dim); display:flex; justify-content:space-between; align-items:center; margin-top:4px;">' +
                    '<span>Stage: <strong>' + escapeHtml(w.pipelineStage) + '</strong></span>' +
                    '<span>' + w.ageMin + 'm</span>' +
                  '</div>' +
                  rosterSnippet +
                  '<div style="display:flex; justify-content:flex-end; gap:6px; margin-top:6px;">' +
                    '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                    '<button class="sm btn-open-orca" data-path="' + escapeHtml(w.worktreePath || '') + '" title="Open Worktree in Orca / Editor">Worktree ↗</button>' +
                  '</div>' +
                '</div>'
              );
            }).join("")) +
          '</div>' +
        '</div>' +

        '<!-- Col 4: Waiting on You -->' +
        '<div class="kanban-col" style="border-color: rgba(245, 158, 11, 0.4);">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title" style="color: var(--warning);">Waiting on You</span>' +
            '<span class="kanban-col-badge" style="background:var(--warning-glow); color:var(--warning); border-color:var(--warning);">' + waiting.length + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            (waiting.length === 0 ? '<div class="empty-state" style="padding:16px;">No questions open</div>' : waiting.map(w => {
              const proj = w.project || "general";
              const rosterSnippet = (w.roster && w.roster.length > 0) ? (
                '<div style="font-size:10px; color:var(--text-muted); background:var(--surface); border:1px solid var(--border-subtle); border-radius:4px; padding:3px 6px; margin-top:4px;">' +
                  '<span><strong>' + w.roster.length + ' Agent' + (w.roster.length > 1 ? 's' : '') + ':</strong> ' +
                  w.roster.map(a => (a.role === 'coordinator' ? '👑 ' : '⚙️ ') + escapeHtml(a.provider) + ' (' + escapeHtml(a.role) + ': ' + escapeHtml(a.assignedStatus) + ')').join(', ') +
                  '</span>' +
                '</div>'
              ) : '';
              return (
                '<div class="kanban-card waiting">' +
                  '<div class="kanban-card-meta">' +
                    '<span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</span>' +
                    '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(w.identifier) + ' in Linear"><strong>' + escapeHtml(w.identifier) + ' ↗</strong></a>' +
                    '<span class="badge badge-waiting">Action Needed</span>' +
                  '</div>' +
                  '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="kanban-card-title-link" title="Open in Linear">' + escapeHtml(w.title) + '</a>' +
                  '<div style="font-size:11px; color:var(--text-muted); background:var(--surface); padding:6px 8px; border-radius:4px; border:1px solid var(--border-subtle); margin-top:4px;">' +
                    escapeHtml((w.openQuestion ? w.openQuestion.prompt || '' : '').slice(0, 140)) + '...' +
                  '</div>' +
                  rosterSnippet +
                  '<div style="display:flex; gap:6px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;">' +
                    answerInLinearLink(w) +
                  '</div>' +
                '</div>'
              );
            }).join("")) +
          '</div>' +
        '</div>' +

        '<!-- Col 5: In Review / PR -->' +
        '<div class="kanban-col">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title">In Review / PR</span>' +
            '<span class="kanban-col-badge">' + inReview.length + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            (inReview.length === 0 ? '<div class="empty-state" style="padding:16px;">No open reviews</div>' : inReview.map(w => {
              const proj = w.project || "general";
              const rosterSnippet = (w.roster && w.roster.length > 0) ? (
                '<div style="font-size:10px; color:var(--text-muted); background:var(--surface); border:1px solid var(--border-subtle); border-radius:4px; padding:3px 6px; margin-top:4px;">' +
                  '<span><strong>' + w.roster.length + ' Agent' + (w.roster.length > 1 ? 's' : '') + ':</strong> ' +
                  w.roster.map(a => (a.role === 'coordinator' ? '👑 ' : '⚙️ ') + escapeHtml(a.provider) + ' (' + escapeHtml(a.role) + ': ' + escapeHtml(a.assignedStatus) + ')').join(', ') +
                  '</span>' +
                '</div>'
              ) : '';
              return (
                '<div class="kanban-card">' +
                  '<div class="kanban-card-meta">' +
                    '<span class="badge badge-project" title="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</span>' +
                    '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="issue-link" title="Open ' + escapeHtml(w.identifier) + ' in Linear"><strong>' + escapeHtml(w.identifier) + ' ↗</strong></a>' +
                    '<span class="badge badge-pass">Gates Passed</span>' +
                  '</div>' +
                  '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer" class="kanban-card-title-link" title="Open in Linear">' + escapeHtml(w.title) + '</a>' +
                  rosterSnippet +
                  '<div style="display:flex; gap:6px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;">' +
                    (w.prUrl ? '<a href="' + escapeHtml(w.prUrl) + '" target="_blank" rel="noopener noreferrer"><button class="sm primary">View PR ↗</button></a>' : '') +
                    '<a href="' + escapeHtml(w.linearUrl || "https://linear.app") + '" target="_blank" rel="noopener noreferrer"><button class="sm" title="Open in Linear">Linear ↗</button></a>' +
                    '<button class="sm btn-open-orca" data-path="' + escapeHtml(w.worktreePath || '') + '" title="Open Worktree in Orca / Editor">Worktree ↗</button>' +
                  '</div>' +
                '</div>'
              );
            }).join("")) +
          '</div>' +
        '</div>' +

        '<!-- Col 6: Done / Merged -->' +
        '<div class="kanban-col">' +
          '<div class="kanban-col-header">' +
            '<span class="kanban-col-title" style="color: var(--success);">Done / Merged</span>' +
            '<span class="kanban-col-badge">' + d.funnel.done + '</span>' +
          '</div>' +
          '<div class="kanban-cards">' +
            '<div class="kanban-card" style="background:rgba(16, 185, 129, 0.05); border-color:rgba(16, 185, 129, 0.2);">' +
              '<div style="display:flex; align-items:center; justify-content:space-between;">' +
                '<span style="font-size:11px; color:var(--text-dim); text-transform:uppercase; font-weight:700;">Shipped</span>' +
                '<span class="badge badge-pass">Merged</span>' +
              '</div>' +
              '<div style="font-size:24px; font-weight:800; font-family:var(--font-mono); color:var(--success); margin:4px 0;">' +
                d.funnel.done + ' <span style="font-size:12px; font-weight:500; color:var(--text-muted);">issues</span>' +
              '</div>' +
              '<div style="font-size:11px; color:var(--text-muted); line-height:1.4;">' +
                'Shipped in <strong>' + escapeHtml(d.metrics.timeframe) + '</strong> window.' +
              '</div>' +
              '<div style="margin-top:8px; padding-top:8px; border-top:1px solid var(--border-subtle); font-size:11px; color:var(--text-dim); display:flex; justify-content:space-between;">' +
                '<span>Pass Rate: <strong style="color:var(--text);">' + d.metrics.gatePassRate + '%</strong></span>' +
                '<span>Avg: <strong style="color:var(--text);">' + d.metrics.avgCycleMinutes + 'm</strong></span>' +
              '</div>' +
              '<div style="margin-top:10px;">' +
                '<a href="https://linear.app" target="_blank" rel="noopener noreferrer"><button class="sm" style="width:100%;">Open Linear Workspace ↗</button></a>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }

    async function promoteIssue(linearId, identifier, provider) {
      const btns = document.querySelectorAll('[data-id="' + identifier + '"].btn-promote');
      btns.forEach(b => { b.disabled = true; b.textContent = "Promoting..."; });

      showToast("Promoting " + identifier + " to agent-ready in Linear...", "info");
      try {
        const res = await fetch("/api/actions/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linearId, providerLabel: provider || "agent-ready" })
        });
        const d = await res.json();
        if (d.ok) {
          showToast("✓ " + identifier + " marked as agent-ready! Dispatcher will claim it.", "success");
          fetchData().catch(() => {});
        } else {
          showToast("Failed to promote: " + (d.error || d.message), "error");
          btns.forEach(b => { b.disabled = false; b.textContent = "+ Make Agent-Ready"; });
        }
      } catch (err) {
        showToast("Network error: " + err.message, "error");
        btns.forEach(b => { b.disabled = false; b.textContent = "+ Make Agent-Ready"; });
      }
    }

    function answerInLinearLink(w) {
      const url = w.linearUrl || "https://linear.app";
      const guidance = w.linearUrl ? "Reply to Wingmate's existing question as your signed-in owner account." :
        "Find " + w.identifier + " in Linear and reply to Wingmate's existing question as your signed-in owner account.";
      return '<a class="sm" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Answer in Linear ↗</a>' +
        '<div style="font-size:11px; color:var(--text-muted);">' + escapeHtml(guidance) + '</div>';
    }

    async function toggleDispatcherPause() {
      const isPaused = currentData && (currentData.pausedScopes || []).length > 0;
      const pBtn = document.getElementById("pauseBtn");
      pBtn.disabled = true;
      try {
        const res = await fetch("/api/actions/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "global", on: !isPaused })
        });
        const d = await res.json();
        showToast(isPaused ? "Dispatcher resumed" : "Dispatcher paused", "info");
        fetchData().catch(() => {});
      } catch (err) {
        showToast("Error: " + err.message, "error");
      } finally {
        pBtn.disabled = false;
      }
    }

    async function openWorktree(path) {
      if (!path) {
        showToast("No worktree directory provisioned for this issue yet", "info");
        return;
      }
      const dirName = path.split("/").slice(-1)[0] || path;
      showToast("Opening worktree in Orca / Workspace (" + dirName + ")...", "info");
      try {
        const res = await fetch("/api/actions/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "orca", path })
        });
        const d = await res.json();
        if (d.ok) {
          showToast("✓ Worktree opened in Orca / Workspace!", "success");
        } else {
          showToast(d.message || "Failed to open worktree", "error");
        }
      } catch (err) {
        showToast("Open error: " + err.message, "error");
      }
    }

    function scheduleNextPoll() {
      if (pollTimer) clearTimeout(pollTimer);
      const delay = document.hidden ? 10000 : 3000;
      pollTimer = setTimeout(async () => {
        try {
          await fetchData();
        } catch {
          // Keep polling on error
        }
        scheduleNextPoll();
      }, delay);
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        fetchData().catch(() => {});
      }
      scheduleNextPoll();
    });

    // Global Event Delegation for buttons
    document.addEventListener("click", e => {
      const promoteBtn = e.target.closest(".btn-promote");
      if (promoteBtn) {
        promoteIssue(promoteBtn.dataset.linearId, promoteBtn.dataset.id, promoteBtn.dataset.provider);
        return;
      }
      const orcaBtn = e.target.closest(".btn-open-orca");
      if (orcaBtn) {
        openWorktree(orcaBtn.dataset.path);
        return;
      }
    });

    // Startup
    applyTheme(currentTheme);
    switchView(currentView);
    fetchData().catch(() => {});
    scheduleNextPoll();
  </script>
</body>
</html>`;
}
