import { expect, test, type Page } from '@playwright/test';

// Classroom smoke + screenshots in screenshot mode (?shot=N): fixed seed, fixed step, N frames.
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

const SHOTS: [string, string][] = [
  ['seat', 'lesson=lecture&t=40&bot=angel'],
  ['overview', 'lesson=lecture&t=90&bot=prankster&debug=1'],
  ['seat', 'lesson=film&t=60&bot=sneaky&device=phone&hud=1'],
  ['front', 'lesson=group&t=30&bot=postman'],
  ['top', 'lesson=lecture&t=120&bot=chaos&debug=1'],
];
for (const [cam, extra] of SHOTS) {
  test(`classroom renders (${cam} ${extra})`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.goto(`/classroom.html?shot=3&seed=1&cam=${cam}&${extra}`);
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
    const i = await page.evaluate(() => window.__info);
    expect(i?.app).toBe('classroom');
    expect(i?.webgl2).toBe(true);
    expect(Number(i?.tick)).toBeGreaterThan(0);
    await page.screenshot({
      path: `screenshots/latest/classroom-${cam}-${extra.split('&')[0]!.split('=')[1]}-${extra.includes('debug') ? 'debug-' : ''}${info.project.name}.png`,
    });
    expect(errors).toEqual([]);
  });
}

test('classroom sim is deterministic for a seed', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const run = async (seed: string) => {
    await page.goto(`/classroom.html?shot=3&t=20&bot=sneaky&seed=${seed}&cam=overview`);
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
    return page.evaluate(() => window.__info?.hash);
  };
  const a = await run('7');
  const b = await run('7');
  const c = await run('8');
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test('classroom interactive: title → class → phone → decoy → stand/walk', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'ipad-keyboard', 'covered by desktop + ipad-touch');
  const errors = collectErrors(page);
  await page.goto('/classroom.html?test=1');
  await page.waitForSelector('text=Enter class');
  await page.screenshot({ path: `screenshots/latest/classroom-title-${info.project.name}.png` });
  await page.click('text=Enter class');
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game?: { world?: { tick: number } } }).__game;
    return !!g?.world && g.world.tick > 10;
  });
  type G = {
    world: {
      ps: { device: { kind: string | null; mode: string } };
      player: { sittingIn: string | null; pos: { x: number; z: number } };
      tick: number;
    };
    queue: (c: object) => void;
  };
  const g = () => (window as unknown as { __game: G }).__game;
  await page.evaluate(() =>
    (window as unknown as { __game: { queue: (c: object) => void } }).__game.queue({
      device: 'phone',
    }),
  );
  await page.waitForFunction(
    () => (window as unknown as { __game: G }).__game.world.ps.device.kind === 'phone',
  );
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `screenshots/latest/classroom-play-phone-${info.project.name}.png`,
  });
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(
    () => (window as unknown as { __game: G }).__game.world.ps.device.mode === 'decoy',
  );
  await page.keyboard.press('Digit1');
  await page.waitForFunction(
    () => (window as unknown as { __game: G }).__game.world.ps.device.kind === null,
  );
  await page.keyboard.press('Space');
  await page.waitForFunction(
    () => (window as unknown as { __game: G }).__game.world.player.sittingIn === null,
  );
  const before = await page.evaluate(() => ({
    ...(window as unknown as { __game: G }).__game.world.player.pos,
  }));
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyS');
  const after = await page.evaluate(() => ({
    ...(window as unknown as { __game: G }).__game.world.player.pos,
  }));
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.1);
  await page.keyboard.press('Escape');
  await page.waitForSelector('text=Paused');
  await page.screenshot({ path: `screenshots/latest/classroom-pause-${info.project.name}.png` });
  void g;
  expect(errors).toEqual([]);
});

test('classroom benchmark route reports stats', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const errors = collectErrors(page);
  await page.goto('/classroom.html?bench=3&preset=battery');
  await page.waitForFunction(() => !!(window as unknown as { __bench?: unknown }).__bench, null, {
    timeout: 120_000,
  });
  const b = await page.evaluate(
    () => (window as unknown as { __bench: Record<string, number | string> }).__bench,
  );
  expect(Number(b.frames)).toBeGreaterThan(0);
  expect(Number(b.estGpuMB)).toBeGreaterThan(0);
  expect(Number(b.estGpuMB)).toBeLessThan(1024);
  expect(b.preset).toBe('battery');
  await page.screenshot({ path: 'screenshots/latest/classroom-bench-desktop.png' });
  expect(errors).toEqual([]);
});
