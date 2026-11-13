import { defineConfig } from '@playwright/test';

// Headless Chromium has no GPU here: WebGL2 runs on SwiftShader (software). Slow but deterministic,
// so visual tests use "screenshot mode" (?shot=N) which renders N fixed frames and then stops.
const gpuArgs = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 240_000,
  },
  use: { baseURL: 'http://localhost:4173', launchOptions: { args: gpuArgs } },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
    {
      name: 'ipad-keyboard',
      use: {
        viewport: { width: 1180, height: 820 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
      },
    },
    {
      name: 'ipad-touch',
      use: {
        viewport: { width: 1180, height: 820 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
