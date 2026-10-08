// src/server/html.ts — Self-contained, high-performance HTML/CSS/JS dashboard for the Wingmate Console.
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wingmate Console · Architect Pipeline</title>
  <style>
    :root {
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
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
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
    }
    button:hover { background: var(--surface-hover); border-color: var(--accent); }
    button.primary { background: var(--accent); color: #020617; border-color: var(--accent); font-weight: 600; }
    button.primary:hover { opacity: 0.9; }
    button.warning { background: var(--warning); color: #020617; border-color: var(--warning); font-weight: 600; }
    button.sm { padding: 3px 8px; font-size: 11px; }

    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .logo { font-size: 15px; font-weight: 700; letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px; }
    .logo-badge { background: var(--accent); color: #020617; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-text { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

    .header-right { display: flex; align-items: center; gap: 12px; }
    .time-selector, .project-selector {
      background: var(--surface-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }

    .container { max-width: 1440px; margin: 0 auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 24px; }

    /* Funnel Strip */
    .funnel-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .section-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
    .funnel-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
    }
    .funnel-step {
      background: var(--surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: relative;
      transition: all 0.2s ease;
    }
    .funnel-step:hover { border-color: var(--accent); transform: translateY(-2px); }
    .funnel-step.highlight { border-color: var(--warning); background: rgba(245, 158, 11, 0.05); }
    .funnel-step.active { border-color: var(--accent); background: rgba(56, 189, 248, 0.05); }
    .step-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
    .step-count { font-size: 26px; font-weight: 800; font-family: var(--font-mono); color: var(--text); }
    .step-subtext { font-size: 11px; color: var(--text-dim); }

    /* Triage Section */
    .triage-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .table th { text-align: left; padding: 8px 12px; font-size: 11px; text-transform: uppercase; color: var(--text-dim); border-bottom: 1px solid var(--border); }
    .table td { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
    .table tr:hover td { background: var(--surface-hover); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .badge-bouncr { background: #3B82F622; color: #60A5FA; border: 1px solid #3B82F644; }
    .badge-smart-dispatcher { background: #10B98122; color: #34D399; border: 1px solid #10B98144; }
    .badge-jr-learning-plus { background: #F59E0B22; color: #FBBF24; border: 1px solid #F59E0B44; }
    .badge-jr-travel-atlas { background: #8B5CF622; color: #A78BFA; border: 1px solid #8B5CF644; }
    .badge-claude { background: #EA580C22; color: #FB923C; border: 1px solid #EA580C44; }
    .badge-codex { background: #0284C722; color: #38BDF8; border: 1px solid #0284C744; }

    /* Active Worktrees */
    .worktrees-grid { display: flex; flex-direction: column; gap: 14px; }
    .worktree-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .worktree-card.waiting { border-color: var(--warning); box-shadow: 0 0 16px rgba(245, 158, 11, 0.08); }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .card-meta { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 12px; }
    .card-title { font-size: 15px; font-weight: 600; color: var(--text); margin-top: 4px; }

    /* 8 Gates Pipeline Dots */
    .pipeline-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-elevated);
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
    }
    .gate-step { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; color: var(--text-muted); }
    .gate-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--surface-hover);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .gate-dot.pass { background: var(--success); border-color: var(--success); box-shadow: 0 0 6px var(--success-glow); }
    .gate-dot.fail { background: var(--danger); border-color: var(--danger); }
    .gate-dot.active { background: var(--warning); border-color: var(--warning); box-shadow: 0 0 6px var(--warning-glow); }
    .gate-dot.na { background: var(--surface-hover); border-color: var(--text-dim); }
    .gate-connector { flex: 1; height: 2px; background: var(--border); max-width: 24px; }

    /* Roles & Sub-agents */
    .roles-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .role-chip {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
    }

    /* Question / Alert box */
    .alert-box {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .alert-header { font-weight: 700; color: var(--warning); display: flex; align-items: center; gap: 6px; }
    .alert-text { font-size: 13px; color: var(--text); }
    .alert-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }

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
    }
    .stat-label { font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; }
    .stat-val { font-size: 22px; font-weight: 800; font-family: var(--font-mono); color: var(--text); }

    /* Projects Strip */
    .projects-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    .project-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .project-card-title { font-weight: 700; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }

    .empty-state { text-align: center; padding: 32px; color: var(--text-dim); font-size: 13px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo">
        <span class="logo-badge">Wingmate</span>
        <span>Architect Console</span>
      </div>
      <div class="pulse-dot" id="pulseDot"></div>
      <div class="status-text" id="statusSummary">Connecting to local dispatcher...</div>
    </div>
    <div class="header-right">
      <select id="projectSelect" class="project-selector" onchange="fetchData()">
        <option value="">All Pilot Projects</option>
        <option value="bouncr">Bouncr</option>
        <option value="smart-dispatcher">Smart Dispatcher</option>
        <option value="jr-learning-plus">JR Learning Plus</option>
        <option value="jr-travel-atlas">JR Travel Atlas</option>
      </select>
      <select id="timeframeSelect" class="time-selector" onchange="fetchData()">
        <option value="today">Today</option>
        <option value="7d" selected>Last 7 Days</option>
        <option value="30d">Last 30 Days</option>
        <option value="all">All Time</option>
      </select>
      <button onclick="toggleDispatcherPause()" id="pauseBtn" class="sm">Pause Dispatcher</button>
      <button onclick="fetchData()" class="sm">↻ Refresh</button>
    </div>
  </div>

  <div class="container">
    <!-- 1. Pipeline Funnel Strip -->
    <div class="funnel-container">
      <div class="section-title">
        <span>Lifecycle Pipeline Funnel (Linear ➔ Isolated Worktrees ➔ PR ➔ Done)</span>
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

    <!-- 5. Projects & Automations Cadence -->
    <div>
      <div class="section-title">
        <span>Projects & Harness Automations</span>
      </div>
      <div class="projects-grid" id="projectsGrid">
        <!-- Injected via JS -->
      </div>
    </div>
  </div>

  <script>
    let currentData = null;

    async function fetchData() {
      const proj = document.getElementById("projectSelect").value;
      const tf = document.getElementById("timeframeSelect").value;
      const url = \`/api/snapshot?timeframe=\${tf}\${proj ? '&project=' + proj : ''}\`;

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        currentData = await res.json();
        renderAll(currentData);
      } catch (err) {
        document.getElementById("statusSummary").textContent = "Error loading data: " + err.message;
        document.getElementById("pulseDot").style.background = "var(--danger)";
      }
    }

    function renderAll(d) {
      renderHeader(d);
      renderFunnel(d.funnel);
      renderWorktrees(d.activeWorktrees);
      renderTriage(d.triage);
      renderMetrics(d.metrics);
      renderProjects(d.projects, d.automations);
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
        summary.textContent = \`Dispatcher \${hb.outcome} · last tick \${dur} · exit \${hb.exitCode}\`;
        pBtn.textContent = "Pause Dispatcher";
        pBtn.className = "sm";
      } else {
        dot.style.background = "var(--text-dim)";
        summary.textContent = "Dispatcher waiting for first heartbeat";
      }
    }

    function renderFunnel(f) {
      const g = document.getElementById("funnelGrid");
      g.innerHTML = \`
        <div class="funnel-step">
          <div class="step-label">1. Todo / Backlog</div>
          <div class="step-count">\${f.todo}</div>
          <div class="step-subtext">Linear tickets</div>
        </div>
        <div class="funnel-step highlight">
          <div class="step-label">2. Agent-Ready</div>
          <div class="step-count">\${f.agentReady}</div>
          <div class="step-subtext">Queued for claim</div>
        </div>
        <div class="funnel-step active">
          <div class="step-label">3. In Worktree</div>
          <div class="step-count">\${f.inAgent}</div>
          <div class="step-subtext">Active coordinators</div>
        </div>
        <div class="funnel-step \${f.waitingOnHuman > 0 ? 'highlight' : ''}">
          <div class="step-label">4. Waiting on You</div>
          <div class="step-count" style="\${f.waitingOnHuman > 0 ? 'color: var(--warning)' : ''}">\${f.waitingOnHuman}</div>
          <div class="step-subtext">Needs approval</div>
        </div>
        <div class="funnel-step">
          <div class="step-label">5. Review / PR</div>
          <div class="step-count">\${f.reviewReady}</div>
          <div class="step-subtext">Implementation done</div>
        </div>
        <div class="funnel-step">
          <div class="step-label">6. Done / Merged</div>
          <div class="step-count" style="color: var(--success);">\${f.done}</div>
          <div class="step-subtext">In timeframe</div>
        </div>
      \`;
    }

    function renderWorktrees(wts) {
      const el = document.getElementById("worktreesList");
      document.getElementById("activeCount").textContent = wts.length + " Active";

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

          return \`
            <div class="gate-step" title="\${k}: \${g ? g.verdict || 'pending' : 'pending'}">
              <div class="gate-dot \${statusClass}"></div>
              <span>\${k}</span>
            </div>
            \${idx < gateKeys.length - 1 ? '<div class="gate-connector"></div>' : ''}
          \`;
        }).join("");

        const rolesHtml = (w.roleJobs || []).map(r => \`
          <div class="role-chip">
            <span style="color: var(--purple); font-weight: 700;">\${r.role}</span>
            <span>\${r.provider}</span>
            <span style="color: \${r.verdict === 'PASS' ? 'var(--success)' : r.verdict === 'FAIL' ? 'var(--danger)' : 'var(--warning)'}; font-weight: 700;">\${r.verdict || r.status}</span>
          </div>
        \`).join("");

        return \`
          <div class="worktree-card \${isWaiting ? 'waiting' : ''}">
            <div class="card-header">
              <div>
                <div class="card-meta">
                  <span class="badge badge-\${w.project}">\${w.project}</span>
                  <span style="font-weight: 700; color: var(--text);">\${w.identifier}</span>
                  <span class="badge badge-\${w.provider}">\${w.provider}\${w.model ? ' · ' + w.model : ''}</span>
                  <span style="color: var(--text-dim);">Uptime: \${w.ageMin}m</span>
                  \${w.worktreePath ? '<span style="color: var(--text-dim);">' + w.worktreePath.split('/').slice(-2).join('/') + '</span>' : ''}
                </div>
                <div class="card-title">\${w.title}</div>
              </div>
              <div style="display: flex; gap: 8px;">
                \${w.prUrl ? '<a href="' + w.prUrl + '" target="_blank"><button class="sm">View PR ↗</button></a>' : ''}
                <button class="sm primary" onclick="openWorktree('\${w.worktreePath || ''}')">Open in Orca ↗</button>
              </div>
            </div>

            <!-- 8 Gate Pipeline Visualizer -->
            <div class="pipeline-bar">
              \${gateDots}
            </div>

            <!-- Active Sub-agents & Roles -->
            \${rolesHtml ? '<div class="roles-strip"><span style="font-size: 11px; color: var(--text-dim);">Sub-agent Roles:</span>' + rolesHtml + '</div>' : ''}

            <!-- Waiting on Human Alert -->
            \${isWaiting && w.openQuestion ? \`
              <div class="alert-box">
                <div class="alert-header">
                  <span>⚠️ Waiting on Your Input / Plan Approval</span>
                </div>
                <div class="alert-text">\${w.openQuestion.prompt || "The agent has asked a clarification or plan approval question before proceeding."}</div>
                <div class="alert-actions">
                  <button class="primary sm" onclick="submitAnswer('\${w.identifier}', '\${w.openQuestion.id}', 'Approved, please proceed with implementation.')">✓ Approve Plan</button>
                  <button class="sm" onclick="promptAnswer('\${w.identifier}', '\${w.openQuestion.id}')">Custom Answer...</button>
                  <a href="https://linear.app" target="_blank" style="font-size: 11px; margin-left: 8px;">View in Linear ↗</a>
                </div>
              </div>
            \` : ''}
          </div>
        \`;
      }).join("");
    }

    function renderTriage(triage) {
      const cnt = document.getElementById("triageCount");
      const c = document.getElementById("triageContent");
      cnt.textContent = triage.length + " Candidates";

      if (!triage || triage.length === 0) {
        c.innerHTML = '<div class="empty-state">All Linear Todo issues currently have agent labels assigned. New issues created in Linear will appear here.</div>';
        return;
      }

      c.innerHTML = \`
        <table class="table">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Project</th>
              <th>Linear Title</th>
              <th>Updated</th>
              <th>Recommendation</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            \${triage.map(t => \`
              <tr>
                <td style="font-family: var(--font-mono); font-weight: 700;"><a href="\${t.url}" target="_blank">\${t.identifier}</a></td>
                <td><span class="badge badge-\${t.projectKey}">\${t.projectName}</span></td>
                <td style="font-weight: 500;">\${t.title}</td>
                <td style="color: var(--text-dim); font-size: 11px;">\${t.updatedAt.slice(0, 10)}</td>
                <td><span class="badge badge-\${t.recommendedProvider}">\${t.recommendedProvider}:best</span></td>
                <td style="text-align: right;">
                  <button class="primary sm" onclick="promoteIssue('\${t.linearId}', '\${t.identifier}', '\${t.recommendedProvider}')">+ Make Agent-Ready</button>
                </td>
              </tr>
            \`).join("")}
          </tbody>
        </table>
      \`;
    }

    function renderMetrics(m) {
      document.getElementById("metricsPeriod").textContent = m.timeframe.toUpperCase();
      const g = document.getElementById("statsGrid");
      g.innerHTML = \`
        <div class="stat-card">
          <div class="stat-label">Throughput (Done)</div>
          <div class="stat-val" style="color: var(--success);">\${m.completedCount}</div>
          <div class="step-subtext">\${m.inProgressCount} currently in-flight</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Cycle Time</div>
          <div class="stat-val">\${m.avgCycleMinutes} <span style="font-size: 12px; font-weight: 500; color: var(--text-dim);">min</span></div>
          <div class="step-subtext">Claim to PR Ready</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Gate Pass Rate</div>
          <div class="stat-val" style="color: var(--accent);">\${m.gatePassRate}%</div>
          <div class="step-subtext">Across 8 pipeline stages</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Cost & Usage</div>
          <div class="stat-val">$\${m.costUsd.toFixed(2)}</div>
          <div class="step-subtext">\${(m.tokens / 1000).toFixed(0)}k total tokens</div>
        </div>
      \`;
    }

    function renderProjects(projects, autos) {
      const g = document.getElementById("projectsGrid");
      g.innerHTML = projects.map(p => \`
        <div class="project-card">
          <div class="project-card-title">
            <span>\${p.name}</span>
            <span class="badge badge-\${p.key}">\${p.key}</span>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">
            <span>Active Worktrees:</span>
            <strong style="color: \${p.activeCount > 0 ? 'var(--accent)' : 'var(--text-dim)'};">\${p.activeCount}</strong>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">
            <span>Queued / Ready:</span>
            <strong>\${p.queuedCount}</strong>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">
            <span>Completed:</span>
            <strong style="color: var(--success);">\${p.completedCount}</strong>
          </div>
          <div style="font-size: 11px; color: var(--text-dim); border-top: 1px solid var(--border-subtle); padding-top: 6px; margin-top: 4px;">
            <span>Slot: \${p.slotHeldBy ? '<span style=\"color: var(--warning);\">Held by ' + p.slotHeldBy + '</span>' : '<span style=\"color: var(--success);\">Available</span>'}</span>
          </div>
        </div>
      \`).join("");
    }

    async function promoteIssue(linearId, identifier, provider) {
      if (!confirm(\`Promote \${identifier} to agent-ready with provider \${provider}?\`)) return;
      try {
        const res = await fetch("/api/actions/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linearId, providerLabel: provider || "agent-ready" })
        });
        const d = await res.json();
        if (d.ok) {
          alert(\`\${identifier} marked as agent-ready! The Wingmate dispatcher will pick it up on the next tick.\`);
          fetchData();
        } else {
          alert("Failed to promote: " + d.message);
        }
      } catch (err) {
        alert("Error: " + err.message);
      }
    }

    async function submitAnswer(identifier, questionId, text) {
      try {
        const res = await fetch("/api/actions/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier, questionId, answerText: text })
        });
        const d = await res.json();
        if (d.ok) {
          alert("Approval submitted! The dispatcher will resume the worktree on the next tick.");
          fetchData();
        } else {
          alert("Error: " + d.message);
        }
      } catch (err) {
        alert("Error: " + err.message);
      }
    }

    function promptAnswer(identifier, questionId) {
      const text = prompt("Enter your answer / instructions for the agent:");
      if (text) submitAnswer(identifier, questionId, text);
    }

    async function toggleDispatcherPause() {
      const isPaused = currentData && (currentData.pausedScopes || []).length > 0;
      const res = await fetch("/api/actions/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", on: !isPaused })
      });
      fetchData();
    }

    function openWorktree(path) {
      if (!path) return;
      fetch("/api/actions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "orca", path })
      });
    }

    // Connect SSE for real-time live events
    function setupSSE() {
      const es = new EventSource("/api/events");
      es.onmessage = () => fetchData();
      es.onerror = () => setTimeout(setupSSE, 5000);
    }

    // Initial load
    fetchData();
    setupSSE();
    // Poll backup every 15s
    setInterval(fetchData, 15000);
  </script>
</body>
</html>`;
}
