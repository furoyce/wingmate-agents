import type { ProjectConfig } from "../config/schema";

export interface Routing {
  repo: string;
  basis: "rule" | "default" | "ambiguous";
  candidates: string[];
}

// §10.3: keywords are whole words; the title decides, the description breaks ties; two repos → ambiguous (the brief asks).
export function route(project: ProjectConfig, title: string, description: string | null): Routing {
  const norm = (s: string) =>
    ` ${s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")} `;
  const t = norm(title);
  const d = norm(description ?? "");
  const hits = (text: string) => {
    const repos = new Set<string>();
    for (const r of project.routing.rules)
      if (r.match.some((kw) => text.includes(` ${kw.toLowerCase()} `))) repos.add(r.repo);
    return [...repos];
  };
  const byTitle = hits(t);
  if (byTitle.length === 1)
    return { repo: byTitle[0] ?? project.routing.default, basis: "rule", candidates: byTitle };
  if (byTitle.length > 1)
    return { repo: project.routing.default, basis: "ambiguous", candidates: byTitle.sort() };
  const byDesc = hits(d);
  if (byDesc.length === 1)
    return { repo: byDesc[0] ?? project.routing.default, basis: "rule", candidates: byDesc };
  if (byDesc.length > 1)
    return { repo: project.routing.default, basis: "ambiguous", candidates: byDesc.sort() };
  return { repo: project.routing.default, basis: "default", candidates: [] };
}
