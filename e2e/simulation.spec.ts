import { test, expect } from "@playwright/test";

test.describe("simulation shell", () => {
  test("renders the control panel and map", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "LA On-Demand Bus Sim" })).toBeVisible();
    await expect(page.getByText("Simulation Time")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("starting the simulation swaps Start for Pause and advances the clock", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start" }).click();

    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    // Ticks every 400ms; the clock should leave 0 well within the default timeout.
    await expect(page.getByText(/^[1-9]\d*$/)).toBeVisible();

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });
});
