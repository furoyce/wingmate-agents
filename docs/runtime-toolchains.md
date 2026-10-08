# Repository runtime toolchains

Set an optional `runtimeBinPaths` list on one repository in the trusted Wingmate projects configuration when it
needs a different runtime from the host default:

```yaml
projects:
  smart-dispatcher:
    repos:
      main:
        # Alongside the existing orcaRepo, github, setup and gates fields.
        runtimeBinPaths:
          - /Users/OWNER/.local/share/wingmate-toolchains/node-v22.23.3-darwin-arm64/bin
```

Use actual absolute directory names. `~`, environment expansion, relative paths, PATH separators, control
characters and sandbox glob syntax are rejected. This field accepts directories only; it cannot inject arbitrary
environment variables or shell commands. An absent or empty list preserves the existing runtime behavior.

At kit installation, the dispatcher resolves symlinks and prepends these directories, in order, to **its own PATH**.
Empty inherited PATH segments are omitted. All remaining entries must be absolute directories; relative entries
(such as `.` or `bin`) and entries inside the current repository/worktree are rejected. The resolved PATH is pinned for setup, the initial coordinator, successor coordinators, all reviewer terminals, legacy
worker terminals and computed validation/security subprocesses. Claude's protected settings also pin PATH so
user-level Claude environment settings cannot silently replace it. Terminal-job mode continues to reject graph
workers; runtime configuration does not enable them.

`launch.json` contains the resolved runtime and is in the kit integrity set. The dispatcher also writes an identical
runtime receipt to the OS-account default `~/.local/share/wingmate/kit/<ISSUE>/runtime.json`. Computed gates anchor
this path to the OS account home, independent of `HOME`, Wingmate environment overrides, launch metadata and executable
location. Repository runtimes require the default state location; configured runtimes with custom state roots are
refused before installation. This issue's sandbox can read that protected kit directory and cannot write it. Computed
gates compare the receipt with launch metadata before any subprocess or gate write; they do not read private records,
credentials or ledger files. An edited/removed runtime mirror produces `kit_tampered`; unavailable
directories, changed directory symlinks or missing/invalid receipts produce `runtime_invalid`.

Runtime sandbox grants are read-only. They cover the resolved bin directories and resolved executable-symlink
targets. npm/npx/corepack links into `node_modules` grant only their own package directory, which they need to load
their code. Wingmate never grants a bin directory's parent automatically. Broad roots, the owner's home itself,
known credential directories, Wingmate state/config and the current repository/worktree roots are rejected. The
dedicated `<state>/toolchains/<installation>/...` namespace is a narrow exception; granting one bin/package there
does not grant its state siblings or the toolchains directory itself. Existing credential blanking and secret-read denies remain in force. Other runtime layouts must keep their required files
within these narrow grants or the existing operator-approved toolchain grants; failures do not widen the sandbox.

The receipt pins path selection, not an immutable copy of every tool binary. Keep this toolchain owner-controlled;
updates to its contents require normal operator validation. Configuration changes apply to newly installed kits.
Existing kits retain their pinned runtime. Default-state legacy kits with no runtime receipt retain their previous
behavior. New custom-state legacy kits receive read access and an explicit write deny for only the exact OS-default
runtime receipt file, so gates can authenticate the absence of a configured runtime without exposing state siblings.
Older custom-state kits may lack that read grant and fail closed: re-queue them to install current sandbox settings.
An unreadable anchor is never treated as proof that no runtime exists. Re-queue an issue to adopt changed runtime configuration. Removing an active toolchain blocks later launches/gates rather
than falling back to the host runtime.

## Optional persistent Node 22 installation recipe (macOS arm64)

This recipe is for an operator to review and run separately. Wingmate does not download or install toolchains and
does not change global Node, Homebrew links, shell profiles or package-manager defaults.

The official [Node 22.23.3 archive](https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz) was checked
against the release's [SHA-256 manifest](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt) for the pilot:

- Archive SHA-256: `23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53`
- Extracted `bin/node` SHA-256: `68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b`

Download into a fresh temporary directory, verify before extraction, and refuse to overwrite an existing toolchain:

```sh
(
set -eu
wingmate_node_download=$(mktemp -d)
wingmate_toolchain_root="$HOME/.local/share/wingmate-toolchains"
wingmate_node_name=node-v22.23.3-darwin-arm64
curl --fail --location "https://nodejs.org/dist/v22.23.3/$wingmate_node_name.tar.gz" \
  --output "$wingmate_node_download/$wingmate_node_name.tar.gz"
printf '%s  %s\n' \
  23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 \
  "$wingmate_node_download/$wingmate_node_name.tar.gz" | shasum -a 256 -c - &&
test ! -e "$wingmate_toolchain_root/$wingmate_node_name" &&
mkdir -p "$wingmate_toolchain_root" &&
tar -xzf "$wingmate_node_download/$wingmate_node_name.tar.gz" -C "$wingmate_toolchain_root"

printf '%s  %s\n' \
  68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b \
  "$wingmate_toolchain_root/$wingmate_node_name/bin/node" | shasum -a 256 -c -
"$wingmate_toolchain_root/$wingmate_node_name/bin/node" --version
)
```

Require both checksum checks to pass and version output `v22.23.3`. Then configure that installation's absolute bin
directory only for repositories requiring it. Verify `node --version` and the repository-declared package-manager
version from the issue's sandbox before accepting a live pilot. A `/tmp` toolchain is suitable for a bounded probe,
but should not back unattended automation because cleanup can remove it.
