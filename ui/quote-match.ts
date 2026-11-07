export function uniqueQuoteOffset(text: string, quote: string, prefix = "", suffix = ""): number | null {
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = collapse(quote), before = collapse(prefix), after = collapse(suffix);
  if (!wanted) return null;
  let found: number | null = null;
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
    if ((before && !text.slice(0, at).trimEnd().endsWith(before)) || (after && !text.slice(at + wanted.length).trimStart().startsWith(after))) continue;
    if (found !== null) return null;
    found = at;
  }
  return found;
}
