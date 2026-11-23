import assert from 'node:assert/strict';
import type { Locator } from 'playwright';

/** Late layout inside the real transcript, independent of model and network latency. */
export async function assertTimelineScroll(log: Locator) {
  const page = log.page();
  const jump = log.locator('..').getByRole('button', { name: 'Aller au dernier message' });
  if (await jump.isVisible()) await jump.click();
  const fixture = await log.evaluateHandle(viewport => {
    const rows = document.createElement('section');
    for (let i = 0; i < 100; i++) {
      const row = document.createElement('p');
      row.textContent = 'Event ' + i;
      row.style.height = '48px';
      rows.append(row);
    }
    viewport.firstElementChild!.append(rows);
    return rows;
  });
  const bottom = () => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  const settled = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  try {
    await settled();
    assert.ok(await bottom() <= 1, 'Pinned after a large append');
    await log.hover();
    await page.mouse.wheel(0, -900);
    await jump.waitFor();
    await settled();
    const anchor = await log.evaluateHandle(el => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)!;
    });
    const offset = () => anchor.evaluate(el => el.getBoundingClientRect().top);
    const before = await offset();
    await fixture.evaluate(rows => {
      rows.prepend(rows.firstElementChild!.cloneNode(true));
      (rows.firstElementChild as HTMLElement).style.height = '210px';
      for (let i = 0; i < 12; i++) rows.append(rows.lastElementChild!.cloneNode(true));
    });
    await settled();
    assert.ok(Math.abs(await offset() - before) < 2, 'Visible row anchored after prepend, resize and event burst');
    await jump.click();
    await settled();
    assert.ok(await bottom() <= 1);
    await log.focus();
    await log.hover();
    await page.mouse.wheel(0, -900);
    await jump.waitFor();
    await page.waitForFunction(el => !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 300, await log.elementHandle());
    await page.mouse.wheel(0, 1800);
    await jump.waitFor({ state: 'hidden' });
    await fixture.evaluate(rows => (rows.lastElementChild as HTMLElement).style.height = '510px');
    await settled();
    const size = page.viewportSize()!;
    await page.setViewportSize({ ...size, height: size.height - 160 });
    await settled();
    assert.ok(await bottom() <= 1, "Pinned when the keyboard reduces the viewport");
    await page.setViewportSize(size);
    await settled();
    const distance = await bottom();
    assert.ok(distance <= 1, 'Manual return follows streaming growth, gap ' + distance);
    console.log('PASS timeline follow, anchor and reattach');
  } finally {
    await fixture.evaluate(rows => rows.remove());
    await settled();
  }
}
