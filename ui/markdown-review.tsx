// Markdown review interaction adapted from Doc Review (MIT), Copyright (c) 2026 Foma.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Anchor, Comment } from "../src/review-contract";
import type { Strings } from "../src/i18n";
import { clearHighlights, contextAround, findQuoteRange, setHighlights } from "./text-ranges";
import { Button } from "@/components/ui/button";
import { selectionPosition } from "./selection-position";
import { parseSpec, SpecBody, SpecToc } from "./spec-view";

type Candidate = { anchor: Anchor; range: Range };

export function MarkdownReview({ content, comments, t, activeId, editId, onAnchor, onPick, onDetached, composer }: {
  content: string; comments: Comment[]; t: Strings; activeId: string | null; editId: string | null; composer?: ReactNode;
  onAnchor: (anchor: Anchor) => void; onPick: (id: string) => void; onDetached: (ids: Set<string>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const owner = useId();
  const [selection, setSelection] = useState<Candidate | null>(null);
  const [composerRange, setComposerRange] = useState<Range | null>(null);
  const [point, setPoint] = useState({ top: 0, left: 8 });
  const ranges = useRef(new Map<string, Range>());
  const spec = useMemo(() => parseSpec(content), [content]);
  const [badges, setBadges] = useState<{ id: string; seq: number; top: number; left: number }[]>([]);
  const [frames, setFrames] = useState<{ top: number; left: number; width: number; height: number }[]>([]);
  useEffect(() => {
    setSelection(null);
    // A replaced Markdown tree invalidates DOM ranges; retain any draft in the inline form.
    setComposerRange(null);
  }, [content]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const paint = () => {
      const normal: Range[] = []; const active: Range[] = []; const detached = new Set<string>(); const next: typeof badges = []; let box: typeof frames = [];
      const origin = shell.current?.getBoundingClientRect(); ranges.current.clear();
      for (const comment of comments) {
        if (comment.anchor.kind !== "md-text") continue;
        const { quote, prefix, suffix } = comment.anchor;
        const range = findQuoteRange([element], quote, prefix, suffix);
        if (!range) { detached.add(comment.id); continue; }
        normal.push(range); if (comment.id === activeId) active.push(range);
        ranges.current.set(comment.id, range);
        const rects = range.getClientRects(); const last = rects[rects.length - 1];
        if (origin && last) next.push({ id: comment.id, seq: comment.seq, top: last.top - origin.top, left: last.right - origin.left });
        // The active quote gets a frame, not a darker fill; nested inline elements repeat rects inside a line's.
        if (origin && comment.id === activeId) box = Array.from(rects).filter((r, i, all) => !all.some((o, j) => j !== i && o.left <= r.left && o.right >= r.right && o.top <= r.top && o.bottom >= r.bottom && (o.width > r.width || o.height > r.height || j < i)))
          .map(r => ({ top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height }));
      }
      // Badges live outside the Markdown tree, so updating them never retriggers this observer.
      setBadges(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      setFrames(previous => JSON.stringify(previous) === JSON.stringify(box) ? previous : box);
      // The pending range keeps a new quote visible while the form is open; an edited quote already has its own.
      setHighlights(owner, { comment: normal, active, pending: !editId && composerRange?.startContainer.isConnected ? [composerRange] : [] }); onDetached(detached);
    };
    paint();
    // The host Markdown renderer may settle asynchronously after its parent effect.
    const observer = new MutationObserver(paint); observer.observe(element, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(paint); resize.observe(element);
    return () => { observer.disconnect(); resize.disconnect(); clearHighlights(owner); };
  }, [content, comments, activeId, editId, owner, onDetached, composerRange]);
  useEffect(() => {
    const comment = comments.find(c => c.id === activeId);
    if (!root.current || comment?.anchor.kind !== "md-text") return;
    const { quote, prefix, suffix } = comment.anchor;
    const range = findQuoteRange([root.current], quote, prefix, suffix);
    // A collapsed requirement or scenario hides the quote; open it first.
    for (let node = range?.startContainer.parentElement?.closest("details"); node; node = node.parentElement?.closest("details")) node.open = true;
    // scrollIntoView would also shift BB's overflow-hidden layout; scroll only our panel.
    const panel = root.current.closest(".openspec-workspace"); const box = range?.getBoundingClientRect();
    if (panel && box) { const bounds = panel.getBoundingClientRect(); if (box.top < bounds.top || box.bottom > bounds.bottom) panel.scrollBy({ top: box.top - bounds.top - bounds.height / 3 }); }
    // Editing floats the form at the comment's own quote, like a new selection.
    if (range && comment.id === editId) { setSelection(null); setComposerRange(range); }
  }, [activeId, editId]);
  const pickAt = () => {
    const current = window.getSelection();
    if (!current?.isCollapsed || !current.anchorNode) return;
    const point = current.anchorNode; const offset = current.anchorOffset;
    const hit = comments.find(c => ranges.current.get(c.id)?.isPointInRange(point, offset));
    if (hit) onPick(hit.id);
  };
  const capture = useCallback(() => {
    const current = window.getSelection();
    if (!current?.rangeCount || current.isCollapsed || !root.current) { setSelection(null); return; }
    const range = current.getRangeAt(0);
    if (!root.current.contains(range.startContainer) || !root.current.contains(range.endContainer)) { setSelection(null); return; }
    const quote = range.toString().trim();
    if (!quote || quote.length > 4000 || !range.getClientRects().length) { setSelection(null); return; }
    setSelection({ anchor: { kind: "md-text", quote, ...contextAround(range, root.current, root.current) }, range: range.cloneRange() });
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>; let dragging = false;
    // Wait for the drag to end, so the action never appears under the moving pointer.
    const changed = () => { clearTimeout(timer); if (!dragging) timer = setTimeout(capture, 180); };
    const dismiss = (event: PointerEvent) => { dragging = Boolean(root.current?.contains(event.target as Node)); if (!shell.current?.contains(event.target as Node)) setSelection(null); };
    const released = () => { if (dragging) { dragging = false; changed(); } };
    // Drop the native selection too, or the Escape keyup would capture it again.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && root.current?.contains(window.getSelection()?.anchorNode ?? null)) { window.getSelection()?.removeAllRanges(); setSelection(null); } };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerup", released, true);
    return () => { clearTimeout(timer); document.removeEventListener("selectionchange", changed); document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", escape); document.removeEventListener("pointerup", released, true); };
  }, [capture]);
  // Save and Cancel both close the form: drop its range so the pending highlight goes too.
  useEffect(() => { if (!composer) setComposerRange(null); }, [!composer]);
  const floatingRange = composer ? composerRange : selection?.range;
  useLayoutEffect(() => {
    if (!floatingRange || !shell.current || !popup.current) return;
    const position = () => {
      const box = shell.current; const menu = popup.current;
      if (!box || !menu || !floatingRange.startContainer.isConnected) return;
      const rects = floatingRange.getClientRects(); const last = rects[rects.length - 1];
      if (!last) return;
      const panel = box.closest(".openspec-workspace");
      if (!panel) return;
      const bounds = panel.getBoundingClientRect();
      const visible = { top: Math.max(0, bounds.top), bottom: Math.min(window.innerHeight, bounds.bottom) };
      const next = selectionPosition(last, box.getBoundingClientRect(), visible, menu.getBoundingClientRect());
      setPoint(previous => previous.top === next.top && previous.left === next.left ? previous : next);
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(shell.current); observer.observe(popup.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [floatingRange, composer]);
  return <section ref={shell} className="relative min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => { setSelection(null); setComposerRange(null); onAnchor({ kind: "doc" }); }}>{t.wholeDocument}</Button>
    </div>
    {spec && <SpecToc blocks={spec} root={root} t={t} />}
    {/* An edited quote gets the floating form next frame; rendering it inline first would jerk the scroll. */}
    {composer && !composerRange && !(editId && ranges.current.has(editId)) && composer}
    {floatingRange && <div ref={popup} className={`absolute z-20 max-w-[calc(100%-1rem)] ${composer ? "openspec-floating w-[min(22rem,calc(100%-1rem))] rounded-lg bg-popover text-popover-foreground shadow-lg" : "rounded-md bg-popover shadow-md"}`} style={{ top: point.top, left: point.left, marginTop: 0 }}>
      {composer || <Button variant="outline" className="h-8 max-w-full px-2.5 text-xs text-popover-foreground" onMouseDown={event => event.preventDefault()} onClick={() => {
        if (!selection) return;
        // The pending highlight replaces the native selection, so Cancel leaves nothing selected.
        setComposerRange(selection.range); setSelection(null); window.getSelection()?.removeAllRanges(); onAnchor(selection.anchor);
      }}>{t.commentSelection}</Button>}
    </div>}
    {frames.map((f, i) => <div key={i} aria-hidden className="pointer-events-none absolute -m-0.5 rounded-sm ring-2 ring-primary/70" style={{ top: f.top, left: f.left, width: f.width + 4, height: f.height + 4 }} />)}
    {badges.map(b => <button key={b.id} type="button" aria-label={`${t.comment} #${b.seq}`} onClick={() => onPick(b.id)} className={`absolute z-10 -translate-y-1/2 rounded-full px-1.5 text-[10px] leading-4 font-medium shadow-sm ${b.id === activeId ? "bg-primary text-primary-foreground" : "bg-amber-200 text-amber-950 hover:bg-amber-300 dark:bg-amber-700 dark:text-amber-50"}`} style={{ top: b.top, left: b.left }}>{b.seq}</button>)}
    <div ref={root} data-sidebar-swipe-selectable="" onMouseUp={capture} onKeyUp={capture} onClick={pickAt} className="openspec-markdown min-w-0 break-words" tabIndex={0} aria-label={t.viewDocument}>
      {spec ? <SpecBody blocks={spec} /> : <Markdown content={content} />}
    </div>
  </section>;
}
