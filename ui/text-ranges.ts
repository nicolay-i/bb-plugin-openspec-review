// Adapted from Doc Review (MIT), Copyright (c) 2026 Foma. See LICENSES/doc-review-MIT.txt.
// DOM text search and CSS Custom Highlight plumbing for the Markdown view.
import { uniqueQuoteOffset } from "./quote-match";

interface TextIndex {
  /** Whitespace-collapsed text of the scope. */
  text: string;
  /** For each character of `text`, the node and offset it came from. */
  nodes: Text[];
  offsets: number[];
}

function indexText(scopes: readonly Element[]): TextIndex {
  const index: TextIndex = { text: "", nodes: [], offsets: [] };
  let lastWasSpace = true;
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const value = node.data;
      for (let offset = 0; offset < value.length; offset += 1) {
        const char = value[offset]!;
        const space = /\s/.test(char);
        if (space && lastWasSpace) continue;
        index.text += space ? " " : char;
        index.nodes.push(node);
        index.offsets.push(offset);
        lastWasSpace = space;
      }
      node = walker.nextNode() as Text | null;
    }
    if (!lastWasSpace) {
      // Block boundaries behave like whitespace in selections.
      index.text += " ";
      index.nodes.push(index.nodes[index.nodes.length - 1]!);
      index.offsets.push(index.offsets[index.offsets.length - 1]! + 1);
      lastWasSpace = true;
    }
  }
  return index;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Returns only a unique exact quote/context match; ambiguous anchors stay detached.
 */
export function findQuoteRange(
  scopes: readonly Element[],
  quote: string,
  prefix = "",
  suffix = "",
): Range | null {
  const wanted = collapse(quote);
  if (!wanted || scopes.length === 0) return null;
  const index = indexText(scopes);
  const best = uniqueQuoteOffset(index.text, wanted, prefix, suffix);
  if (best === null) return null;
  const endChar = best + wanted.length - 1;
  const range = document.createRange();
  try {
    range.setStart(index.nodes[best]!, index.offsets[best]!);
    const endNode = index.nodes[endChar]!;
    range.setEnd(endNode, Math.min(index.offsets[endChar]! + 1, endNode.data.length));
  } catch {
    return null;
  }
  return range;
}

/** Text immediately before and after a range, within the blocks it starts and ends in. */
export function contextAround(
  range: Range,
  startScope: Element,
  endScope: Element,
): { prefix: string; suffix: string } {
  const before = document.createRange();
  before.setStart(startScope, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(endScope, endScope.childNodes.length);
  return {
    prefix: collapse(before.toString()).slice(-60),
    suffix: collapse(after.toString()).slice(0, 60),
  };
}

// --- Highlights -----------------------------------------------------------
//
// CSS highlight names are global to the page, while several review tabs can
// be open at once. Each view registers its ranges here and the registry
// publishes the union under three names styled in app.css.

type Layer = "comment" | "active" | "pending";

const LAYERS: Layer[] = ["comment", "active", "pending"];
const registry = new Map<string, Record<Layer, Range[]>>();

interface HighlightApi {
  highlights?: Map<string, unknown>;
}

function publishHighlights(): void {
  const api = (globalThis.CSS as unknown as HighlightApi | undefined)?.highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (!api || !HighlightCtor) return;
  for (const layer of LAYERS) {
    const ranges = [...registry.values()].flatMap((entry) => entry[layer]);
    const name = `openspec-review-${layer}`;
    if (ranges.length === 0) api.delete(name);
    else api.set(name, new HighlightCtor(...ranges));
  }
}

export function setHighlights(owner: string, layers: Partial<Record<Layer, Range[]>>): void {
  registry.set(owner, {
    comment: layers.comment ?? [],
    active: layers.active ?? [],
    pending: layers.pending ?? [],
  });
  publishHighlights();
}

export function clearHighlights(owner: string): void {
  registry.delete(owner);
  publishHighlights();
}

export function supportsHighlights(): boolean {
  return Boolean(
    (globalThis.CSS as unknown as HighlightApi | undefined)?.highlights &&
      (globalThis as unknown as { Highlight?: unknown }).Highlight,
  );
}
