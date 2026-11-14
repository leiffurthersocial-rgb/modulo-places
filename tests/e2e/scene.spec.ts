import { expect, test, type Page } from '@playwright/test';

// Visual + smoke tests run in screenshot mode (?shot=N): fixed seed, fixed camera, N frames.
// SwiftShader is CPU rendering, so no timing assertions here; see /bench on real hardware.

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

const MOODS = ['dawn', 'midday', 'dusk'];
const CAMERAS = ['spawn', 'glade'];

for (const mood of MOODS) {
  test(`forest renders mood "${mood}"`, async ({ page }, info) => {
    const errors = collectErrors(page);
    const preset = info.project.name === 'desktop' ? 'high' : 'medium';
    for (const cam of CAMERAS) {
      await page.goto(`/?shot=2&scene=forest&mood=${mood}&cam=${cam}&preset=${preset}`);
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
      const i = await page.evaluate(() => window.__info);
      expect(i?.mood).toBe(mood);
      expect(Number(i?.instances)).toBeGreaterThan(5_000);
      await page.screenshot({
        path: `screenshots/latest/forest-${mood}-${cam}-${info.project.name}.png`,
        timeout: 180_000,
      });
    }
    expect(errors).toEqual([]);
  });
}

test('photo mode DOF capture path renders', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const errors = collectErrors(page);
  await page.goto(
    '/?shot=2&scene=forest&mood=midday&cam=low-ferns&preset=high&focal=85&dof=1&focus=4&f=2',
  );
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 90_000 });
  await page.screenshot({ path: `screenshots/latest/forest-photo-dof.png` });
  expect(errors).toEqual([]);
});

test('menu → scene → capture → exit, repeated, does not leak GPU resources', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await page.goto('/?test=1&preset=saver');
  await expect(page.getByRole('button', { name: /enter/i }).first()).toBeVisible();
  const samples: { geometries: number; textures: number }[] = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__app!.enterScene('greybox'));
    if (i === 0) {
      // Exercise photo mode and a 1x capture once.
      const captured = await page.evaluate(async () => {
        const app = window.__app!;
        app.togglePhoto(true);
        let got = 0;
        const off = app.events.on('photo:captured', (e) => (got = e.width));
        await app.capture(1);
        off();
        app.togglePhoto(false);
        return got;
      });
      expect(captured).toBeGreaterThan(0);
    }
    await page.evaluate(() => window.__app!.exitToMenu());
    samples.push(await page.evaluate(() => window.__app!.memory()));
  }
  console.log('memory after each exit', JSON.stringify(samples));
  // After the first cycle (shader/cache warm-up), counts must be stable.
  expect(samples[3]!.geometries).toBeLessThanOrEqual(samples[1]!.geometries);
  expect(samples[3]!.textures).toBeLessThanOrEqual(samples[1]!.textures);
  expect(errors).toEqual([]);
});
