// src/git/remote.ts — the configured GitHub remote (`repos.<name>.github`): the URL every dispatcher push, remote read and fetch goes to
// (C23, C30), and the base branch as GitHub names it.
import type { RepoConfig } from "../config/schema";

/** C23 (§13.3 d): `https://github.com/<repos.<name>.github>.git` — never the name `origin`, whose URL the repository's config sets. */
export const githubUrl = (repo: Pick<RepoConfig, "github">): string =>
  `https://github.com/${repo.github}.git`;

/** C30: `repos.<name>.base` as the branch GitHub has — `origin/main` (or `refs/remotes/origin/main`) is `main`. */
export const remoteBranch = (base: string): string => base.replace(/^(?:refs\/remotes\/)?origin\//, "");
