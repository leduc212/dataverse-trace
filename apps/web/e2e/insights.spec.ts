// v0.3 journeys: long-range trends from rollups, insight evidence and drill-down, and thresholds.
import { expect, test } from '@playwright/test';
import { openDemo } from './helpers.ts';

const finding = (page: import('@playwright/test').Page, title: string | RegExp) => page.locator('.finding').filter({ has: page.locator('.title', { hasText: title }) });

test('dashboard: 90 days come from hourly summaries, with the collection gap shaded and counted', async ({ page }) => {
  await openDemo(page, '/dashboard?r=90d');
  await expect(page.locator('.tile', { hasText: 'Data coverage' })).toContainText('3 days not collected');
  await expect(page.locator('.tile', { hasText: 'p95 sync duration' })).toContainText('≈');
  await expect(page.getByText(/comes from hourly summaries/)).toBeVisible();
  await expect(finding(page, /No data was collected for/)).toContainText('UTC');
});

test('dashboard: the last 7 days are compared with the 7 days before', async ({ page }) => {
  await openDemo(page, '/dashboard?r=7d');
  // The ERP call slowed down after the "deployment" 5 days ago.
  await expect(page.locator('.tile', { hasText: 'p95 sync duration' }).locator('.delta')).toContainText('▲');
  await expect(page.locator('table.data tr', { hasText: 'Harbor.Plugins.PolicyErpSync' }).locator('.delta').first()).toBeVisible();
});

test('insights: an error spike shows its evidence and opens the last 24 hours of failures', async ({ page }) => {
  await openDemo(page, '/dashboard?r=7d');
  const spike = finding(page, 'Harbor.Plugins.PolicyNotify started failing');
  await expect(spike.locator('.evidence')).toContainText('7 days before: 0 of');
  await spike.getByRole('button', { name: /Show the executions \(last 24 h\)/ }).click();
  await expect(page).toHaveURL(/#\/explorer\?.*r=24h/);
  const first = page.getByRole('grid', { name: 'Results' }).getByRole('row').first();
  await expect(first).toContainText('PolicyNotify');
});

test('insights: thresholds change what is reported, and can be restored', async ({ page }) => {
  await openDemo(page, '/dashboard?r=7d');
  await expect(finding(page, /^Depth 8 reached/)).toBeVisible();
  await page.getByRole('button', { name: 'Thresholds' }).click();
  const dialog = page.getByRole('dialog', { name: 'Finding thresholds' });
  await dialog.getByRole('textbox', { name: 'Possible loop at depth' }).fill('9');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(finding(page, /^Depth 8 reached/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Thresholds' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Possible loop at depth' })).toHaveValue('9');
  await dialog.getByRole('textbox', { name: 'Possible loop at depth' }).fill('x');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(dialog).toBeHidden();
  await expect(finding(page, /^Depth 8 reached/)).toBeVisible();
});

test('platform statistics: Dataverse counters per plug-in type, with what the snapshots showed', async ({ page }) => {
  await openDemo(page, '/dashboard?r=7d');
  const table = page.getByRole('table', { name: 'Platform statistics' });
  await expect(table.getByRole('row', { name: /Harbor\.Plugins\.PolicyNotify/ })).toContainText('%');
  await expect(page.getByText(/Dataverse updated them about every 1h 00m/)).toBeVisible();
  await expect(table.getByText('experimental')).toBeVisible();
});
