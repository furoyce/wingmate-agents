<div align="center">

# 🪽 Wingmate Agents

### **Universal Coding Agent Automation & Safety Plugin**
#### *Orchestrating Orca Automations · Claude Code Routines · OpenAI Codex Scheduled Tasks*

[![Linear Verified](https://img.shields.io/badge/Linear-Verified_App-5E6AD2?style=for-the-badge&logo=linear&logoColor=white)](https://linear.app)
[![Orca Plugin](https://img.shields.io/badge/Orca-ADE_Automation_Plugin-0284C7?style=for-the-badge)](#2-orca-ade-automation-plugin)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Routine_Relay-D97706?style=for-the-badge&logo=anthropic&logoColor=white)](#3-claude-code--codex-integration)
[![Codex Ready](https://img.shields.io/badge/Codex-Scheduled_Review_Loop-10B981?style=for-the-badge&logo=openai&logoColor=white)](#3-claude-code--codex-integration)
[![Bun Runtime](https://img.shields.io/badge/Runtime-Bun_v1.4+-FBF0DF?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript_Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Deterministic Gates](https://img.shields.io/badge/Safety_Gates-8%2F8_Deterministic-10B981?style=for-the-badge)](#the-8-deterministic-safety-gates)
[![Theme Support](https://img.shields.io/badge/Console_Theme-Light_(Orca)_%7C_Dark_%7C_System-64748B?style=for-the-badge)](#-architect-console-ui)

<p align="center">
  <b>Supercharge your existing coding agents with autonomous Linear-to-GitHub orchestration.</b><br>
  Wingmate operates as an orchestration and safety plugin that harnesses your native coding assistants (Orca, Claude Code, Codex) to interact with Linear issues, Git worktrees, and GitHub PRs—<b>without creating a redundant competing chatbot harness</b>.
</p>

---

### **Pipeline Lifecycle Stages**

| Stage | Badge | Meaning |
| :--- | :--- | :--- |
| **1. Todo** | ![Todo](https://img.shields.io/badge/Stage-Todo_%2F_Backlog-64748B?style=flat-square) | Unassigned candidate issues in Linear awaiting architect prioritization |
| **2. Agent-Ready** | ![Agent-Ready](https://img.shields.io/badge/Stage-Agent--Ready-0284C7?style=flat-square) | Labeled and queued for autonomous pickup by the dispatcher |
| **3. In Worktree** | ![In Worktree](https://img.shields.io/badge/Stage-In_Worktree-F59E0B?style=flat-square) | Native agent actively implementing code in an isolated sandboxed Git worktree |
| **4. Waiting on You** | ![Waiting on You](https://img.shields.io/badge/Stage-Waiting_on_You-EF4444?style=flat-square) | Paused for human plan review, clarification question, or architecture approval |
| **5. In Review / PR** | ![In Review](https://img.shields.io/badge/Stage-In_Review_%2F_PR-A855F7?style=flat-square) | All 8 gates passed, verified pull request opened on GitHub |
| **6. Done / Merged** | ![Done](https://img.shields.io/badge/Stage-Done_%2F_Merged-10B981?style=flat-square) | PR merged, Linear issue closed, worktree safely reclaimed |

</div>

---

## ⚡ Why Wingmate as a Plugin?

Coding agents like **Orca ADE**, **Claude Code**, and **OpenAI Codex** are already exceptional at conversational code reasoning, editing, and tool execution. Developers do not need another chat window.

What developers and architects actually need is the **deterministic outer loop**:
- **🔌 Native Harness Interoperability**: Wingmate uses your existing automations (`.orca/automations`, Claude Code tool routines, Codex scheduled tasks) to drive agents via the native chatbot harness rather than creating a new harness.
- **🔒 Credential-Free Agent Sandboxes**: Agents never hold Git credentials, API keys, or direct push rights. All writes and comments occur via the official Wingmate Linear OAuth app.
- **🛡️ 8 Deterministic Safety Gates**: No PR is ever opened without passing automated plan verification, unit tests, strict typechecking, linter checks, secret scanning, and dependency audits.
- **🙋 Human-in-the-Loop Approval**: When agents formulate an implementation plan or hit ambiguous requirements, execution safely parks and notifies you with 1-click plan approval.
- **🖥️ Architect Console UI**: Zero-dependency, lightweight web dashboard featuring both a 6-stage Kanban board and Funnel pipeline view, **Light theme by default (matching Orca ADE)**, **Dark**, and **System** themes.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Schedulers["Native Agent Automations & Harnesses"]
        Orca["Orca ADE (.orca/automations)"]
        Claude["Claude Code (Tool Routine Relay)"]
        Codex["Codex (Scheduled Review Loop)"]
    end

    subgraph Linear["Linear Issue Tracker"]
        L1["Issue Created in Backlog"] -->|Triage & Priority| L2["Label: agent-ready"]
        L4["Human Answer / Plan Approval"] -->|Resume| W1
    end

    subgraph Wingmate["Wingmate Plugin & Dispatcher (Zero LLM Outer Loop)"]
        Schedulers -->|Trigger Cadence / On-Demand| D1["Claim Issue & Verify Approver"]
        L2 --> D1
        D1 --> D2["Provision Isolated Worktree wm-issue"]
    end

    subgraph Worktree["Sandboxed Agent Worktree"]
        D2 --> W1["Native Coding Agent (Orca / Claude / Codex)"]
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

### 2. Orca ADE Automation Plugin
Wingmate integrates natively into Orca ADE as a first-class automation plugin:
- **Native Automation Cadence**: Configures scheduled runs via `.orca/automations` executing `wingmate tick --precheck` every 5 minutes.
- **Orca Light Theme Match**: The Architect Console defaults to a clean, crisp light theme designed to seamlessly match Orca ADE's default UI aesthetic.
- **Integrated Webview**: Run as an embedded Webview tab (`http://127.0.0.1:4848`) alongside active chat sessions.
- **One-Click Worktree Jump**: Clicking **"Open in Orca ↗"** directly opens the agent's active worktree session in your editor.

### 3. Claude Code & Codex Integration
Use Wingmate to orchestrate Claude Code and OpenAI Codex without wrapping them in an unnecessary chatbot layer:
- **Claude Code**: Relay continuous tool routines directly inside isolated Git worktrees (`wm-<issue>`). The native agent handles code reasoning while Wingmate validates gates and surfaces plan approvals.
- **OpenAI Codex**: Trigger scheduled tasks and non-blocking PR review loops.
- **Native Tooling**: Provide `wingmate status --json` and `wingmate scan` directly to your agent's terminal tools.

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

![Theme Modes](https://img.shields.io/badge/Theme-Light_(Default)_%7C_Dark_%7C_System-38BDF8?style=flat-square)
![Views](https://img.shields.io/badge/Views-Pipeline_Funnel_%26_Kanban_Board-A855F7?style=flat-square)
![Automations](https://img.shields.io/badge/Automations-Orca_%7C_Claude_%7C_Codex-10B981?style=flat-square)

- **☀️ Light Theme by Default (Orca-Matched)**: Crisp, high-contrast light theme calibrated to match Orca's default interface color palette.
- **🌙 Dark & 💻 System Modes**: Obsidian slate dark theme and dynamic system theme mode that automatically respects your OS appearance preference.
- **☷ 6-Column Responsive Kanban Board**: Fluid, full-width responsive layout adapting dynamically to any screen width (ultra-wide monitors, laptops, and split panes) with **zero horizontal sliders**.
- **⚡ 1-Click Plan Approval & Question Modals**: Immediate in-app approvals and custom review dialogs that resume blocked agent worktrees without leaving the dashboard.
- **📊 Native Automations & Routines Panel**: Live tracking of Orca Dispatcher Automation, Claude Code Routine Relay, and Codex Scheduled Review loops.
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
