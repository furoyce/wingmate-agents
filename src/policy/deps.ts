// §13.3(e): any manifest or lockfile change requires an owner-granted `allow-deps` label.
const MANIFESTS =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock(b)?|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|Podfile(\.lock)?|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock))$/;

export const depsChanged = (paths: string[]): string[] => paths.filter((p) => MANIFESTS.test(p));

export const depsPolicy = (changed: string[], allowDeps: boolean): { ok: boolean; reason: string | null } =>
  depsChanged(changed).length && !allowDeps
    ? { ok: false, reason: "dependency_change_without_allow_deps" }
    : { ok: true, reason: null };
