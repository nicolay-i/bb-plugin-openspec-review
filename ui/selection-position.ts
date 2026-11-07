// Relative positioning used by the selection action and its comment form.
export interface Box { top: number; bottom: number; left: number; right: number; width: number }
export function selectionPosition(text: Box, container: Box, visible: Pick<Box, "top" | "bottom">, popup: { width: number; height: number }) {
  const gap = 6;
  const left = Math.max(8, Math.min(text.right - container.left - 40, container.width - popup.width - 8));
  const below = text.bottom - container.top + gap;
  const top = below + popup.height <= visible.bottom - container.top - 8
    ? below
    : Math.max(visible.top - container.top + 8, text.top - container.top - popup.height - gap);
  return { top: Math.max(visible.top - container.top + 8, Math.min(top, visible.bottom - container.top - popup.height - 8)), left };
}
