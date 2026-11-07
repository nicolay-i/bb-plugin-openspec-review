import assert from "node:assert/strict";
import { selectionPosition } from "../ui/selection-position.ts";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width });
for (const width of [336, 456, 616]) {
  const container = box(100, -200, width, 1800);
  const visible = { top: 40, bottom: 600 };
  const text = box(100 + width - 50, 300, 50, 20);
  const button = selectionPosition(text, container, visible, { width: 180, height: 32 });
  assert.equal(button.top + container.top, text.bottom + 6);
  assert.ok(button.left >= 8 && button.left + 180 <= width - 8);
  const form = selectionPosition(text, container, visible, { width: Math.min(352, width - 16), height: 240 });
  assert.ok(form.left >= 8 && form.left + Math.min(352, width - 16) <= width - 8);
  const bottom = box(150, 560, 60, 20);
  const above = selectionPosition(bottom, container, visible, { width: 180, height: 32 });
  assert.equal(above.top + container.top + 32, bottom.top - 6);
  for (const y of [-300, 800]) {
    const scrolled = selectionPosition(box(150, y, 60, 20), container, visible, { width: 180, height: 240 });
    assert.ok(scrolled.top + container.top >= visible.top + 8);
    assert.ok(scrolled.top + container.top + 240 <= visible.bottom - 8);
  }
}
console.log("Selection positioning: beside quote, clamped to narrow panel, flips above bottom edge OK.");
