// Records docs/media/demo.gif for the README: walks the demo with Playwright and encodes the
// screenshots as a GIF. Run with `pnpm readme-gif` (builds first). PW_CHANNEL=msedge uses Edge.
import { chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../docs/media/demo.gif');
const PORT = 4176;
const WIDTH = 1280;
const HEIGHT = 760;

const frames: Array<{ png: Buffer; delay: number }> = [];
const shot = async (page: Page, delay: number) => frames.push({ png: await page.screenshot(), delay });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await pause(500);
  }
  throw new Error(`${url} didn't start`);
}

async function record(page: Page) {
  await page.addInitScript(() => localStorage.setItem('dataverse-trace:tour-done', '1'));
  await page.goto(`http://localhost:${PORT}/#/explorer?r=all`);
  await page.getByRole('button', { name: /^Synced/ }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Dismiss' }).first().click();
  await shot(page, 2200);

  // Explorer → a recursive loop.
  const filter = page.getByRole('textbox', { name: 'Filter query' });
  await filter.fill('depth>=6');
  await filter.press('Enter');
  await page.getByRole('grid', { name: 'Results' }).getByRole('row').first().getByText(/depth|Update/i).first().waitFor();
  await pause(600);
  await shot(page, 1600);
  await page.getByRole('grid', { name: 'Results' }).getByRole('row').first().click();
  await page.getByRole('button', { name: 'Open timeline' }).waitFor();
  await pause(400);
  await shot(page, 2000);
  await page.getByRole('button', { name: 'Open timeline' }).click();
  await page.locator('.wf-label').first().waitFor();
  await pause(400);
  await shot(page, 2600);

  // Record story with an inferred flow link and its evidence.
  await page.goto(`http://localhost:${PORT}/#/record`);
  await page.getByRole('combobox', { name: 'Table' }).click();
  await page.getByRole('option', { name: 'hbr_policy', exact: true }).click();
  await page.getByRole('textbox', { name: 'Record name' }).fill('HP-10000');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('cell', { name: 'HP-10000', exact: true }).first().click();
  const statusSaves = page.locator('.save-item', { hasText: 'hbr_status' });
  await statusSaves.first().waitFor();
  const flowRow = page.locator('.wf-label', { hasText: 'Notify underwriter on status change' });
  for (let i = 0; i < 8; i++) {
    await statusSaves.nth(i).click();
    try {
      await flowRow.waitFor({ timeout: 4000 });
      break;
    } catch {
      // Next status change.
    }
  }
  await pause(400);
  await shot(page, 2200);
  await flowRow.click();
  await pause(400);
  await shot(page, 3200);
  await page.getByRole('tab', { name: /Expected vs\. actual/ }).click();
  await pause(400);
  await shot(page, 2600);

  // Expected vs. actual: scenario 6.
  await page.goto(`http://localhost:${PORT}/#/expected?t=account&c=update&cols=hbr_totalpremium`);
  await page.locator('table.expected').waitFor();
  await pause(400);
  await shot(page, 2800);

  // Watch a save as it happens.
  await page.goto(`http://localhost:${PORT}/#/watch`);
  await page.getByRole('combobox', { name: 'Table' }).click();
  await page.getByRole('option', { name: 'hbr_policy', exact: true }).click();
  await page.getByRole('textbox', { name: 'Record name' }).fill('HP-10000');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('cell', { name: 'HP-10000', exact: true }).first().click();
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate save' }).click();
  await pause(800);
  await shot(page, 900);
  const flowArrived = page.locator('.wf-label', { hasText: 'Notify underwriter on status change' });
  for (let i = 0; i < 40 && !(await flowArrived.isVisible()); i++) {
    await pause(1500);
    if (i % 3 === 0) await shot(page, 700);
  }
  await shot(page, 2600);
  await page.getByRole('button', { name: 'Stop' }).click();

  // Dashboard.
  await page.goto(`http://localhost:${PORT}/#/dashboard?r=7d`);
  await pause(1500);
  await shot(page, 3000);
}

async function main() {
  const server = spawn(`pnpm exec vite preview --port ${PORT} --strictPort`, { cwd: resolve(here, '..'), shell: true, stdio: 'ignore' });
  try {
    await waitForServer(`http://localhost:${PORT}`);
    const browser = await chromium.launch(process.env['PW_CHANNEL'] ? { channel: process.env['PW_CHANNEL'] } : {});
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'light' });
    try {
      await record(page);
    } catch (e) {
      await page.screenshot({ path: resolve(here, '../test-results/readme-gif-failure.png') });
      throw e;
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }

  if (process.env['GIF_FRAMES']) {
    // Also write the frames as PNGs, to check them.
    const dir = resolve(here, '../test-results/gif-frames');
    mkdirSync(dir, { recursive: true });
    frames.forEach((f, i) => writeFileSync(resolve(dir, `${String(i).padStart(2, '0')}.png`), f.png));
  }
  const gif = GIFEncoder();
  for (const { png, delay } of frames) {
    const { data, width, height } = PNG.sync.read(png);
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.length);
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay });
  }
  gif.finish();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, gif.bytes());
  console.log(`Wrote ${OUT} (${frames.length} frames, ${(gif.bytes().length / 1024 / 1024).toFixed(1)} MB)`);
}

await main();
