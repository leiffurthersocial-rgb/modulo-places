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

for (const cam of ['seat', 'overview', 'teacher']) {
  test(`classroom greybox renders (${cam})`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.goto(`/classroom.html?shot=3&seed=1&cam=${cam}`);
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
    const i = await page.evaluate(() => window.__info);
    expect(i?.app).toBe('classroom');
    expect(i?.webgl2).toBe(true);
    expect(i?.layoutProblems).toBe(0);
    expect(i?.tick).toBe(3);
    await page.screenshot({ path: `screenshots/latest/classroom-${cam}-${info.project.name}.png` });
    expect(errors).toEqual([]);
  });
}

test('classroom sim is deterministic for a seed', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const run = async (seed: string) => {
    await page.goto(`/classroom.html?shot=6&seed=${seed}&cam=overview`);
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
    return page.evaluate(() => window.__info?.simChecksum);
  };
  const a = await run('7');
  const b = await run('7');
  const c = await run('8');
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});
