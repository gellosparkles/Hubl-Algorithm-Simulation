import { test, expect, Page } from "@playwright/test";

// LA_BOUNDS — must match src/engine/types.ts / FallbackMap projection.
const B = { latMin: 33.9, latMax: 34.15, lngMin: -118.5, lngMax: -118.15 };

async function clickLatLng(page: Page, lat: number, lng: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const x = ((lng - B.lngMin) / (B.lngMax - B.lngMin)) * box.width;
  const y = box.height - ((lat - B.latMin) / (B.latMax - B.latMin)) * box.height;
  await canvas.click({ position: { x, y } });
}

test("inject a manual rider mid-run and watch the promise being made", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");

  // More buses, fewer synthetic riders, a generous promise window → the manual
  // rider is reliably matched within the test timeout.
  const sliders = page.getByRole("slider");
  await sliders.nth(0).click();
  await sliders.nth(0).press("End"); // buses → 20
  await sliders.nth(1).click();
  await sliders.nth(1).press("Home"); // riders/min → 1

  await page.getByRole("button", { name: /advanced settings/i }).click();
  await sliders.nth(7).click();
  await sliders.nth(7).press("End"); // time budget → 60
  await sliders.nth(8).click();
  await sliders.nth(8).press("End"); // max wait → 30

  // Two drop-off hubs: Downtown LA and Santa Monica.
  await page.getByRole("button", { name: "Place Hubs" }).click();
  await clickLatLng(page, 34.0522, -118.2437);
  await clickLatLng(page, 34.0195, -118.4912);
  await expect(page.getByText("2/10", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop Placing" }).click();

  // Start the clock, then inject the request mid-run.
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/^[1-9]\d* min$/)).toBeVisible();

  // Two-pin manual request: pickup near Downtown, destination on the hub → inbound.
  await page.getByRole("button", { name: /request a ride/i }).click();
  await clickLatLng(page, 34.062, -118.255);
  await clickLatLng(page, 34.0522, -118.2437);
  await expect(page.getByRole("button", { name: /submit/i })).toBeEnabled();
  await page.getByRole("button", { name: /submit/i }).click();

  // The request entered the running simulation and is being tracked.
  await expect(page.getByText(/Rider #\d+ · (inbound|outbound)/)).toBeVisible();

  // The tracked rider should be assigned a bus with a promised ETA.
  await expect(page.getByText(/^B\d+$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("tracked-eta")).toHaveText(
    /pickup in ~\d+ min|arriving now|on board|drop-off|arrived/,
    { timeout: 60_000 }
  );
});
