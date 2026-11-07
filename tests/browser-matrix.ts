// Optional live web QA: bun --install=force run tests/browser-matrix.ts
// Uses the existing local Playwright Chromium; never saves or sends a comment.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
const origin = process.env.QA_ORIGIN ?? 'http://127.0.0.1:38886';
// Path of a thread whose checkout has an OpenSpec change, e.g. /projects/<id>/threads/<id>.
const threadPath = process.env.QA_THREAD_PATH ?? assert.fail('Set QA_THREAD_PATH');
const out = '.tmp/qa-web'; await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true });
const page = await browser.newPage({ viewport: { width: 2560, height: 1080 } });
page.setDefaultTimeout(60000);
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 600)); });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 600)));
const results: unknown[] = [];
try {
  await page.goto(`${origin}${threadPath}`);
  const show = page.getByRole('button', { name: /Show right panel/ });
  await page.waitForSelector('[aria-label="Right panel views"], button[aria-label^="Show right panel"]');
  if (await show.isVisible()) await show.click();
  await page.getByRole('toolbar', { name: 'Right panel views' }).getByRole('button', { name: 'OpenSpec', exact: true }).click();
  const root = page.locator('.openspec-workspace');
  const item = page.locator('.openspec-list').getByRole('button', { name: /add-bb-openspec-visual-plugin/ });
  await item.waitFor();
  for (const width of [360, 480, 640, 1000]) {
    await root.evaluate((element, value) => { const panel = element.closest('aside'); if (!panel) throw Error('Missing thread panel'); panel.style.width = `${value + panel.offsetWidth - element.clientWidth}px`; }, width);
    const before = await root.evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth }));
    assert.equal(before.width, width); assert.ok(before.scroll <= width, 'List overflow');
    await item.focus(); await page.keyboard.press('Enter');
    await page.locator('.openspec-detail h2').first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2');
    await page.locator('.openspec-detail').getByRole('button', { name: /proposal\.md/ }).waitFor();
    await page.locator('.openspec-detail').getByText(/^(Threads|Треды)/).waitFor();
    assert.equal(await page.getByRole('button', { name: /Link thread|Unlink/ }).count(), 0, 'Manual linking removed');
    await root.screenshot({ path: `${out}/card-${width}.png` });
    await page.keyboard.press('Tab');
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ''), /proposal\.md/, 'Tab must reach the first artifact row');
    await page.keyboard.press('Enter');
    await page.locator('.openspec-markdown p').first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'proposal.md', 'Document heading must take focus');
    assert.equal(await page.locator('.openspec-list').isVisible(), false, 'Thread panel must not show two columns');
    assert.ok(await root.evaluate(e => e.scrollWidth <= e.clientWidth), 'Document overflow');
    await root.screenshot({ path: `${out}/panel-${width}.png` });
    // Comments column: replaces the document when narrow, sits beside it from 720px.
    const toggle = page.getByRole('button', { name: /^Comments · \d+$/ });
    await toggle.click();
    await page.locator('.openspec-comments').waitFor();
    assert.equal(await page.locator('.openspec-doc').isVisible(), width >= 720, 'Document beside comments only when wide');
    assert.ok(await root.evaluate(e => e.scrollWidth <= e.clientWidth), 'Comments overflow');
    await root.screenshot({ path: `${out}/comments-${width}.png` });
    await toggle.click();
    assert.ok(await page.locator('.openspec-doc').isVisible(), 'Document back after hiding comments');
    console.log(`Thread ${width}px: layout passed; testing selection`);
    // A mouse drag shows the selection action only after release, never under the moving pointer.
    const para = (await page.locator('.openspec-markdown p').first().boundingBox())!;
    await page.mouse.move(para.x + 20, para.y + 8); await page.mouse.down();
    await page.mouse.move(para.x + 160, para.y + 8, { steps: 6 }); await page.waitForTimeout(400);
    assert.equal(await page.getByRole('button', { name: 'Comment on selection', exact: true }).isVisible(), false, 'Selection action during drag');
    await page.mouse.up();
    await page.getByRole('button', { name: 'Comment on selection', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    // Establish a real text selection with a double-click, then extend by keyboard.
    // A noneditable Markdown div does not acquire a text caret merely by tab focus.
    await page.locator('.openspec-markdown p').first().dblclick();
    await page.keyboard.down('Shift');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    const action = page.getByRole('button', { name: 'Comment on selection', exact: true });
    await action.waitFor();
    assert.ok(await page.evaluate(() => (window.getSelection()?.toString().length ?? 0) > 0));
    await action.hover();
    // The outline hover fill is translucent; the wrapper must stay opaque so the text never shows through.
    assert.notEqual(await action.evaluate(e => getComputedStyle(e.parentElement!).backgroundColor), 'rgba(0, 0, 0, 0)', 'Selection action backdrop');
    await action.click();
    const input = page.getByRole('textbox', { name: 'Your comment', exact: true });
    await input.waitFor(); assert.ok(await input.evaluate(e => document.activeElement === e));
    await input.fill('Unsaved keyboard QA draft');
    await root.evaluate(e => { e.scrollTop += 160; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await input.evaluate(e => {
      const form = e.closest('form')!.getBoundingClientRect(); const panel = e.closest('.openspec-workspace')!.getBoundingClientRect();
      return { top: form.top, bottom: form.bottom, left: form.left, right: form.right, panelTop: panel.top, panelBottom: panel.bottom, panelLeft: panel.left, panelRight: panel.right };
    });
    assert.ok(geometry.top >= geometry.panelTop && geometry.bottom <= geometry.panelBottom, 'Composer vertical clipping');
    assert.ok(geometry.left >= geometry.panelLeft && geometry.right <= geometry.panelRight, 'Composer horizontal clipping');
    assert.ok(geometry.right <= page.viewportSize()!.width, 'Composer outside browser viewport');
    await root.screenshot({ path: `${out}/composer-${width}.png` });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => (CSS as any).highlights.get('openspec-review-pending')?.size ?? 0), 0, 'Pending highlight after Cancel');
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ''), '', 'Native selection after Cancel');
    await page.getByRole('button', { name: /Active changes/ }).click();
    assert.ok(await item.evaluate(e => document.activeElement === e));
    results.push({ mode: 'thread', width, keyboardSelection: 'passed', focus: 'passed', overflow: false, composer: geometry });
    console.log(`Thread ${width}px: passed`);
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ origin, engine: 'Playwright Chromium', results }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await writeFile(`${out}/results.json`, JSON.stringify({ origin, results, error: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
