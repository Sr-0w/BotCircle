import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function checkDockedPanels(page: Page, ids: { chat: string; ari: string; ariTask: string }) {
  const chatUrl = page.url();
  const navigate = (route: string) => page.goto(new URL('#/' + route, chatUrl).href);
  const pane = (id: string) => page.locator('[data-panel="' + id + '"]');
  const width = (id: string) => pane(id).evaluate(el => Math.round(el.getBoundingClientRect().width));
  async function exercise(id: string, right = false) {
    const divider = pane(id).getByRole('separator', { name: /.+/ });
    await divider.waitFor();
    assert.equal(await divider.getAttribute('aria-orientation'), 'vertical');
    const initial = await width(id);
    const box = (await divider.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const delta = right ? -32 : 32;
    await page.mouse.move(x, y);
    await page.mouse.down();
    assert.equal(await width(id), initial);
    await page.mouse.move(x + delta, y, { steps: 4 });
    await page.waitForFunction(({ id, size }) => Math.round(document.querySelector('[data-panel="' + id + '"]')!.getBoundingClientRect().width) === size, { id, size: initial + 32 });
    await page.mouse.up();
    await divider.press(right ? 'ArrowRight' : 'ArrowLeft');
    assert.equal(await width(id), initial + 20);
    // Drag past both edges of the permitted range, including outside the handle.
    const dragTo = async (clientX: number) => {
      const boundary = (await divider.boundingBox())!;
      await page.mouse.move(boundary.x + boundary.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(clientX, y);
      await page.mouse.up();
    };
    await dragTo(right ? 2000 : 0);
    assert.equal(await width(id), Number(await divider.getAttribute('aria-valuemin')));
    await dragTo(right ? 0 : 2000);
    assert.equal(await width(id), Number(await divider.getAttribute('aria-valuemax')));
    await divider.press('Home');
    assert.equal(await width(id), Number(await divider.getAttribute('aria-valuemin')));
    await divider.press('End');
    assert.equal(await width(id), Number(await divider.getAttribute('aria-valuemax')));
    await divider.dblclick();
    assert.equal(await width(id), initial);
    await divider.press(right ? 'Shift+ArrowLeft' : 'Shift+ArrowRight');
    assert.equal(await width(id), initial + 48);
    return initial + 48;
  }

  const nav = await exercise('navigation');
  const navDivider = pane('navigation').getByRole('separator');
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    const rect = (await navDivider.boundingBox())!;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    for (const end of ['touchCancel', 'touchEnd'] as const) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 30, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
      assert.equal(await width('navigation'), end === 'touchEnd' ? nav + 30 : nav);
    }
  } finally {
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await touch.detach();
  }
  await navDivider.press('Enter');
  await navDivider.press('Shift+ArrowRight');
  const chat = await exercise('chat', true);
  await page.reload();
  await pane('chat').waitFor();
  assert.equal(await width('navigation'), nav);
  assert.equal(await width('chat'), chat);
  await page.getByRole('button', { name: 'Panneau du chat' }).click();
  await pane('chat').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Panneau du chat' }).click();
  assert.equal(await width('chat'), chat);
  await navigate('agent/' + ids.ari);
  await pane('circle').waitFor();
  assert.equal(await width('circle'), 340, 'Circle details have their own preference');
  const circle = await exercise('circle', true);
  await page.evaluate(task => window.dispatchEvent(new CustomEvent('opendots:code-workspace', { detail: task })), ids.ariTask);
  const code = await exercise('code', true);
  await page.getByRole('button', { name: 'Fermer l’espace de code' }).click();
  assert.equal(await width('circle'), circle);
  await page.evaluate(task => window.dispatchEvent(new CustomEvent('opendots:code-workspace', { detail: task })), ids.ariTask);
  assert.equal(await width('code'), code);
  await page.getByRole('button', { name: 'Fermer l’espace de code' }).click();

  await navigate('settings/team');
  const settings = await exercise('settings');
  const team = await exercise('team');
  await page.reload();
  await pane('team').waitFor();
  assert.equal(await width('settings'), settings);
  assert.equal(await width('team'), team);
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-panel="team"]')!;
    return list.nextElementSibling!.getBoundingClientRect().width >= 299 && document.documentElement.scrollWidth <= innerWidth;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('separator', { name: /.+/ }).count(), 0);
  await page.setViewportSize({ width: 1365, height: 820 });
  await pane('settings').getByRole('separator').waitFor();
  assert.equal(await width('settings'), settings);
  assert.equal(await width('team'), team);
  await navigate('chat/' + ids.chat);
  await pane('chat').waitFor();
  assert.equal(await width('chat'), chat);
  console.log('PASS: six docked panels, live drag, keyboard, reset, bounds, reload, navigation and compact layouts');
}
