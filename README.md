<div align="center">

# 🪽 Wingmate Agents

### **Autonomous Architect Pipeline & Coding Agent Harness for Linear**

[![Linear Verified](https://img.shields.io/badge/Linear-Verified_App-5E6AD2?style=for-the-badge&logo=linear&logoColor=white)](https://linear.app)
[![Bun Runtime](https://img.shields.io/badge/Runtime-Bun_v1.4+-FBF0DF?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript_Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Deterministic Gates](https://img.shields.io/badge/Safety_Gates-8%2F8_Deterministic-10B981?style=for-the-badge)](#the-8-deterministic-safety-gates)
[![Zero NPM Bloat](https://img.shields.io/badge/Dependencies-Zero_NPM_Bloat-059669?style=for-the-badge)](#shipping--distribution)
[![Platforms](https://img.shields.io/badge/Platforms-macOS_%7C_Linux-7C3AED?style=for-the-badge&logo=apple&logoColor=white)](#shipping--distribution)

<p align="center">
  <b>Turn your Linear backlog into verified, production-ready pull requests while you sleep.</b><br>
  Wingmate bridges issue trackers and coding agents running in isolated Git worktrees with deterministic safety gates and human-in-the-loop plan approvals.
</p>

---

### **Pipeline Lifecycle Stages**

| Stage | Badge | Meaning |
| :--- | :--- | :--- |
| **1. Todo** | ![Todo](https://img.shields.io/badge/Stage-Todo_%2F_Backlog-64748B?style=flat-square) | Unassigned candidate issues in Linear awaiting architect prioritization |
| **2. Agent-Ready** | ![Agent-Ready](https://img.shields.io/badge/Stage-Agent--Ready-0284C7?style=flat-square) | Labeled and queued for autonomous pickup by the dispatcher |
| **3. In Worktree** | ![In Worktree](https://img.shields.io/badge/Stage-In_Worktree-F59E0B?style=flat-square) | Agent actively implementing code in an isolated sandboxed Git worktree |
| **4. Waiting on You** | ![Waiting on You](https://img.shields.io/badge/Stage-Waiting_on_You-EF4444?style=flat-square) | Paused for human plan review, clarification question, or architecture approval |
| **5. In Review / PR** | ![In Review](https://img.shields.io/badge/Stage-In_Review_%2F_PR-A855F7?style=flat-square) | All 8 gates passed, verified pull request opened on GitHub |
| **6. Done / Merged** | ![Done](https://img.shields.io/badge/Stage-Done_%2F_Merged-10B981?style=flat-square) | PR merged, Linear issue closed, worktree safely reclaimed |

</div>

---

## ⚡ Highlights

- **🔒 Credential-Free Agent Sandboxes**: Agents never hold Git credentials, API keys, or direct push rights. All writes and comments occur via the official Wingmate Linear OAuth app.
- **🛡️ 8 Deterministic Safety Gates**: No PR is ever opened without passing automated plan verification, unit tests, strict typechecking, linter checks, secret scanning, and dependency audits.
- **🙋 Human-in-the-Loop Approval**: When agents formulate an implementation plan or hit ambiguous requirements, execution safely parks and notifies you with 1-click plan approval.
- **🖥️ Architect Console UI**: Zero-dependency, lightweight web dashboard featuring both a 6-stage Kanban board and Funnel pipeline view, Dark & Light color themes, and in-app modal review dialogs.
- **🔌 Multi-Harness Compatibility**: Works out of the box with **Orca ADE**, **Claude Code**, **OpenAI Codex**, or as a standalone CLI daemon for any Git repository.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Linear["Linear Issue Tracker"]
        L1["Issue Created in Backlog"] -->|Triage & Priority| L2["Label: agent-ready"]
        L4["Human Answer / Plan Approval"] -->|Resume| W1
    end

    subgraph Wingmate["Wingmate Dispatcher (No LLM in Dispatcher)"]
        L2 -->|Tick every 5m| D1["Claim Issue & Verify Approver"]
        D1 --> D2["Provision Isolated Worktree wm-issue"]
    end

    subgraph Worktree["Sandboxed Agent Worktree"]
        D2 --> W1["Coding Agent (Claude / Codex)"]
        W1 -->|Asks Question / Submits Plan| Q1{"Waiting on Human?"}
        Q1 -- Yes --> L4
        Q1 -- No --> G1["Run 8 Deterministic Gates"]
    end

    subgraph Gates["8 Deterministic Verification Gates"]
        G1 --> G_Plan["1. Plan Verification"]
        G_Plan --> G_Build["2. Clean Build"]
        G_Build --> G_Unit["3. Unit Tests"]
        G_Unit --> G_Lint["4. Strict Linter"]
        G_Lint --> G_Type["5. Typecheck"]
        G_Lint --> G_Sec["6. Secret Scan"]
        G_Sec --> G_Deps["7. Dependency Audit"]
        G_Deps --> G_Diff["8. Diff Purity"]
    end

    subgraph GitHub["GitHub Delivery"]
        G_Diff -->|All Passed| PR["Open Pull Request + Linear In-Review"]
    end
```

---

## 📦 How to Ship & Distribute Wingmate

Wingmate is designed for zero-friction distribution across different engineering workflows:

### 1. Standalone Single Binary (Recommended)
Built via Bun's native self-contained compilation (`bun build --compile`). Produces a single executable containing the CLI, the server, and the dashboard with **zero external runtime dependencies**:
```sh
# Build binary
bun run build

# Binary output: dist/wingmate (~60MB self-contained executable)
./dist/wingmate --version
```
- **GitHub Releases**: Pre-compiled binaries for `darwin-arm64` (Apple Silicon), `darwin-x64` (Intel Mac), and `linux-x64`.
- **One-Line Curl Installer**:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/furoyce/wingmate-agents/main/install.sh | bash
  ```
- **Homebrew Tap**:
  ```sh
  brew install furoyce/tap/wingmate
  ```

### 2. Orca ADE Plugin & Automation
Wingmate integrates natively into Orca ADE:
- Configures automated scheduled runs via `.orca/automations` running `wingmate tick --precheck` every 5 minutes.
- Integrated Webview tab renders the Wingmate Architect Console (`http://127.0.0.1:4848`).
- One-click worktree opening: clicking **"Open in Orca ↗"** in the dashboard jumps straight into the agent's active session.

### 3. Claude Code & Codex Harness
Run Wingmate alongside agent CLI tools:
- **Claude Code**: Provide `wingmate status` and `wingmate scan` as tools or slash commands within your Claude Code environment.
- **Codex**: Integrate with scheduled cron jobs and continuous PR review loops.

### 4. Background System Daemon
Run the dispatcher and UI server as a background service:
- **macOS (`launchd`)**: Runs automatically at user login.
- **Linux (`systemd`)**: System service for headless CI/CD runner nodes.

---

## 🚀 Quick Start (5 Minutes)

### Step 1: Install Wingmate
```sh
# Clone repository
git clone https://github.com/furoyce/wingmate-agents.git
cd wingmate-agents

# Install dependencies and build
bun install
bun run build
```

### Step 2: Configure Linear & Projects
Create `config/projects.yaml` defining your workspace, projects, and repositories:
```yaml
workspace:
  team: JRF
  approvers: [your-linear-user-id]
labels:
  agent: { supported: [agent-ready, claude, codex] }
projects:
  my-app:
    linearProject: <linear-project-id>
    repos:
      main:
        github: org/my-app
        base: origin/main
        setup: [npm, ci]
        gates: [[npm, test], [npm, run, check]]
```

### Step 3: Run Diagnostics & Enable
```sh
# Verify connectivity, OAuth, and sandboxes
wingmate doctor

# Install worktree and enable the automation
wingmate install --enable
```

### Step 4: Launch the Architect Console
```sh
# Launch the dashboard and open in browser
wingmate ui --open

# Or run the background UI daemon
wingmate ui --serve &
```
Open **[http://127.0.0.1:4848](http://127.0.0.1:4848)** to monitor active worktrees, view metrics, and review agent plans.

---

## 🎨 Architect Console UI

The built-in Web Console gives engineering architects complete visibility into the autonomous agent fleet:

![UI Modes](https://img.shields.io/badge/Theme-Dark_%26_Light_Modes-38BDF8?style=flat-square)
![Views](https://img.shields.io/badge/Views-Pipeline_Funnel_%26_Kanban_Board-A855F7?style=flat-square)
![Network](https://img.shields.io/badge/Network-Adaptive_Polling_(Zero_Socket_Hung)-10B981?style=flat-square)

- **☀️ / 🌙 Dark & Light Themes**: Obsidian slate dark theme and high-contrast light theme with instant switching and `localStorage` persistence.
- **☷ 6-Column Kanban Board**: Fluid, full-width responsive layout automatically adapting to any screen size (ultra-wide monitors, laptops, and split panes) with **zero horizontal sliders**.
- **⚡ 1-Click Plan Approval**: Immediate in-app approvals and custom review modals that resume blocked agent worktrees without leaving the dashboard.
- **🔄 Smart Adaptive Polling**: 3s active tab polling, 10s background polling, and action-driven instant updates. Completely avoids Chromium's 6-socket per-origin bottleneck.

---

## 🛡️ The 8 Deterministic Safety Gates

Every worktree must satisfy all 8 gates before a pull request can be created:

| Gate | Badge | Description | Enforced By |
| :--- | :--- | :--- | :--- |
| **1. Plan** | ![PASS](https://img.shields.io/badge/Gate_1-Plan_Verified-10B981?style=flat-square) | Structured plan written, verified by cross-agent critique or approved by human | Sub-agent Reviewer |
| **2. Build** | ![PASS](https://img.shields.io/badge/Gate_2-Clean_Build-10B981?style=flat-square) | Project builds cleanly with no compile warnings or errors | Native Toolchain |
| **3. Unit Tests** | ![PASS](https://img.shields.io/badge/Gate_3-Unit_Tests-10B981?style=flat-square) | 100% of test suite passes; regressions automatically trigger retry loop | Test Runner |
| **4. Linter** | ![PASS](https://img.shields.io/badge/Gate_4-Strict_Linter-10B981?style=flat-square) | Strict code formatting and static analysis rules enforced | Biome / ESLint |
| **5. Typecheck** | ![PASS](https://img.shields.io/badge/Gate_5-Typecheck-10B981?style=flat-square) | Zero TypeScript or compiler type errors allowed | `tsc --noEmit` |
| **6. Secret Scan** | ![PASS](https://img.shields.io/badge/Gate_6-Secret_Scan-10B981?style=flat-square) | High-entropy scan prevents leaking API keys, private tokens, or credentials | AST Detector |
| **7. Dependency Audit** | ![PASS](https://img.shields.io/badge/Gate_7-Dependency_Audit-10B981?style=flat-square) | Prohibits adding unreviewed lockfile dependencies without explicit `allow-deps` | Manifest Guard |
| **8. Diff Purity** | ![PASS](https://img.shields.io/badge/Gate_8-Clean_Diff-10B981?style=flat-square) | Rejects unexpected file modifications outside designated project paths | Path Filter |

---

## 💻 CLI Command Reference

```sh
# --- UI & Dashboard ---
wingmate ui [--port 4848] [--open [browser|orca]] [--serve]

# --- Real-Time Monitoring ---
wingmate status                               # View active worktrees, token usage, cost, and gate status
wingmate status --json                        # Machine-readable snapshot for automations
wingmate status --project <key>               # Filter by project

# --- Dispatcher Automation ---
wingmate tick --precheck                      # Run one dispatch tick with pre-flight checks
wingmate tick --dry-run                       # Inspect eligible issues without claiming them

# --- Safety & Controls ---
wingmate pause [--scope <project|global>]     # Temporarily pause dispatcher claiming
wingmate resume [--scope <project|global>]    # Resume dispatcher claiming
wingmate stop --issue <ID>                    # Emergency stop: kill agent process & worktree immediately
wingmate stop --all --reason "Maintenance"    # Global kill switch

# --- Maintenance & Verification ---
wingmate doctor [--quick]                     # Comprehensive diagnostic suite (Linear, Orca, Sandboxes)
wingmate scan --diff                          # Inspect staged changes for security & policy violations
```

---

## 🔒 Security & Privacy Guarantees

- **No Agent Git Push Rights**: Agents do not have credentials to push to remote GitHub repositories. Wingmate's host dispatcher publishes the branch only after all gates pass.
- **Isolated Network Allowlist**: Agent sandboxes can only access permitted package registries (`registry.npmjs.org`). Direct outbound internet access and GitHub API access are blocked.
- **Auditability**: Every agent session records full terminal logs, token counts, and USD cost tracking in `.wingmate/records/`.

---

## 📚 Documentation

- [📖 Operations Runbook](docs/runbook.md): Daily operational routines, answering questions, handling incidents, and cost optimization.
- [🔑 Linear App Setup](docs/linear-app-setup.md): One-time OAuth application setup, label provisioning, and saved views.
- [🛠️ Runtime Toolchains](docs/runtime-toolchains.md): Pinning Node, Bun, and Python environments per repository without polluting global tools.
- [📐 Design Specification](docs/superpowers/specs/2026-10-05-wingmate-agents-design.md): Deep architectural specification.

---

## 🛠️ Contributing & Development

```sh
# Run TypeScript typecheck
bun run check

# Run Biome linter & formatter
bun run lint

# Run all 900+ unit and simulation tests
bun test

# Compile standalone binary
bun run build
```

---

<div align="center">
  <sub>Built with 🪽 by the Wingmate Team · Powered by Bun & TypeScript</sub>
</div>
