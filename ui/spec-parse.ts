export type Scenario = { title: string; body: string };
export type Requirement = { title: string; delta: string | null; body: string; scenarios: Scenario[] };
export type Block = { markdown: string } | Requirement;

/** Splits an OpenSpec spec into requirements and scenarios; other Markdown stays as-is. Null when not a spec. */
export function parseSpec(content: string): Block[] | null {
  if (!/^### Requirement:/m.test(content)) return null;
  const blocks: Block[] = []; let delta: string | null = null; let fence = false;
  let requirement: Requirement | null = null; let scenario: Scenario | null = null; let loose: { markdown: string } | null = null;
  const append = (line: string) => {
    const target = scenario ?? requirement;
    if (target) { target.body += `${line}\n`; return; }
    if (!loose) blocks.push(loose = { markdown: "" });
    loose.markdown += `${line}\n`;
  };
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{2,4}) (.*)$/.exec(line);
    if (heading?.[1] === "##") {
      requirement = scenario = null;
      // Delta sections become per-requirement labels; other sections keep their heading.
      delta = /^(ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/.exec(heading[2]!.trim())?.[1] ?? null;
      if (!delta) append(line);
    } else if (heading?.[1] === "###" && heading[2]!.startsWith("Requirement:")) {
      scenario = loose = null; blocks.push(requirement = { title: heading[2]!, delta, body: "", scenarios: [] });
    } else if (heading?.[1] === "####" && heading[2]!.startsWith("Scenario:") && requirement) {
      requirement.scenarios.push(scenario = { title: heading[2]!, body: "" });
    } else append(line);
  }
  return blocks;
}
