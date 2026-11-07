import type { RefObject } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { Strings } from "../src/i18n";
import type { Block, Requirement } from "./spec-parse";
export { parseSpec } from "./spec-parse";

const requirements = (blocks: Block[]) => blocks.filter((b): b is Requirement => "title" in b);
const deltaClass: Record<string, string> = {
  ADDED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  MODIFIED: "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  REMOVED: "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100",
  RENAMED: "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
};
// The label is CSS-generated, so it never enters the text that comment quotes are matched against.
const DeltaLabel = ({ delta }: { delta: string | null }) => delta ? <span aria-label={delta} data-delta={delta} className={`mr-2 inline-block rounded px-1.5 align-middle text-[10px] leading-4 font-semibold tracking-wide before:content-[attr(data-delta)] ${deltaClass[delta]}`} /> : null;

/** Table of contents and expand/collapse controls; rendered outside the reviewed text. */
export function SpecToc({ blocks, root, t }: { blocks: Block[]; root: RefObject<HTMLElement | null>; t: Strings }) {
  const toggleAll = (open: boolean) => root.current?.querySelectorAll("details").forEach(d => { d.open = open; });
  const jump = (index: number) => {
    const target = root.current?.querySelector<HTMLDetailsElement>(`[data-requirement="${index}"]`); if (!target) return;
    target.open = true;
    // scrollIntoView would also shift BB's overflow-hidden layout; scroll only our panel.
    const panel = target.closest(".openspec-workspace"); if (!panel) return;
    panel.scrollBy({ top: target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8 });
  };
  return <nav aria-label={t.contents} className="space-y-1.5 rounded-lg border border-border p-2.5">
    <div className="flex items-center gap-2"><span className="text-xs font-medium text-muted-foreground">{t.contents}</span>
      <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => toggleAll(true)}>{t.expandAll}</Button>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => toggleAll(false)}>{t.collapseAll}</Button></div>
    <ol className="space-y-0.5">{requirements(blocks).map((r, i) => <li key={i}><button type="button" className="w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted" onClick={() => jump(i)}>
      <DeltaLabel delta={r.delta} />{r.title.replace(/^Requirement:\s*/, "")} <span className="text-xs text-muted-foreground">· {r.scenarios.length}</span></button></li>)}</ol>
  </nav>;
}

export function SpecBody({ blocks }: { blocks: Block[] }) {
  let index = 0;
  return <div className="space-y-3">{blocks.map((block, i) => !("title" in block) ? <Markdown key={i} content={block.markdown} />
    : <details key={i} open data-requirement={index++} className="group rounded-lg border border-border">
      <summary className="cursor-pointer list-none px-3 py-2 font-semibold before:mr-1.5 before:inline-block before:text-muted-foreground before:transition-transform before:content-['›'] group-open:before:rotate-90"><DeltaLabel delta={block.delta} />{block.title}</summary>
      <div className="space-y-2 px-3 pb-3">
        {block.body.trim() && <Markdown content={block.body} />}
        {block.scenarios.map((s, j) => <details key={j} open className="group/s rounded-md border border-border bg-muted/40">
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-sm font-medium before:mr-1.5 before:inline-block before:text-muted-foreground before:transition-transform before:content-['›'] group-open/s:before:rotate-90">{s.title}</summary>
          <div className="openspec-scenario px-2.5 pb-2"><Markdown content={s.body} /></div>
        </details>)}
      </div>
    </details>)}</div>;
}
