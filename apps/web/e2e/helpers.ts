import { expect, type Page } from '@playwright/test';

/** Opens the demo at `hash` and waits for the first sync. The tour is skipped unless asked for. */
export async function openDemo(page: Page, hash = '/explorer', options: { tour?: boolean } = {}) {
  if (!options.tour) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('dataverse-trace:tour-done', '1');
      } catch {
        // Ignore.
      }
    });
  }
  await page.goto(`/#${hash}`);
  await expect(page.getByRole('button', { name: /^Synced/ })).toBeVisible({ timeout: 60_000 });
}

/** Picks a record in the record picker by table and name. */
export async function pickRecord(page: Page, table: string, name: string) {
  await page.getByRole('combobox', { name: 'Table' }).click();
  await page.getByRole('option', { name: table, exact: true }).click();
  await page.getByRole('textbox', { name: 'Record name' }).fill(name);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('cell', { name, exact: true }).first().click();
}

/** Waterfall row labels, in order. */
export function waterfallLabels(page: Page) {
  return page.locator('.wf-label');
}

/** Opens the record story of HP-10000 and selects the first status change whose story has a Notify flow. */
export async function openPolicyStoryWithFlow(page: Page) {
  await openDemo(page, '/record');
  await pickRecord(page, 'hbr_policy', 'HP-10000');
  await expect(page.locator('.save-item').first()).toBeVisible();
  const statusSaves = page.locator('.save-item', { hasText: 'hbr_status' });
  const count = await statusSaves.count();
  for (let i = 0; i < Math.min(count, 8); i++) {
    await statusSaves.nth(i).click();
    const flow = waterfallLabels(page).filter({ hasText: 'Notify underwriter on status change' });
    try {
      await expect(flow).toBeVisible({ timeout: 5000 });
      return flow;
    } catch {
      // Try the next status change.
    }
  }
  throw new Error('No status change with a linked flow run found');
}
