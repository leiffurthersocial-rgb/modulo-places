import { expect, test } from '@playwright/test';

test('pipeline scene renders with WebGL2, post-processing and Rapier', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?shot=4');
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
  const gl = await page.evaluate(() => window.__info);
  console.log(info.project.name, JSON.stringify(gl));
  expect(gl?.webgl2).toBe(true);
  expect(Number(gl?.rapierBallY)).toBeLessThan(1);
  await page.screenshot({ path: `screenshots/latest/smoke-${info.project.name}.png` });
  expect(errors).toEqual([]);
});
