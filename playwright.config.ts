import { defineConfig, devices } from "@playwright/test";

/**
 * Stock Playwright config — replaces the previous `lovable-agent-playwright-config`
 * import, which was never listed in package.json and is not installable outside
 * the Lovable platform.
 *
 * `webServer` boots the Vite dev server automatically, so `npm run e2e` works
 * from a clean checkout. Browsers must be installed once:
 *   npx playwright install chromium
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: "http://localhost:8080",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:8080",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
