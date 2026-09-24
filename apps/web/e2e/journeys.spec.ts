// The main journeys from engineering §4, against the demo.
import { expect, test } from '@playwright/test';
import { openDemo, openPolicyStoryWithFlow, pickRecord, waterfallLabels } from './helpers.ts';

test('the guided tour starts on the first visit and can be closed', async ({ page }) => {
  await openDemo(page, '/explorer', { tour: true });
  const tour = page.getByRole('dialog', { name: 'Guided tour' });
  await expect(tour).toContainText('Tour · 1 of 5');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(tour).toContainText('Trends and findings');
  await tour.getByRole('button', { name: 'Close the tour' }).click();
  await expect(tour).toBeHidden();
});

test('explorer: filter, open an operation, and read why its spans are linked', async ({ page }) => {
  await openDemo(page, '/explorer?r=all');
  await page.getByRole('textbox', { name: 'Filter query' }).fill('depth>=6');
  await page.getByRole('textbox', { name: 'Filter query' }).press('Enter');
  const first = page.getByRole('grid', { name: 'Results' }).getByRole('row').first();
  await expect(first).toBeVisible();
  await first.dblclick();
  await expect(page).toHaveURL(/#\/trace\//);
  await expect(page.locator('.trace-summary')).toContainText('Max depth');
  await expect(page.locator('.trace-summary')).toContainText('8');
  // A nested request: its panel explains the link to the step that caused it.
  await waterfallLabels(page).filter({ hasText: 'Update account' }).first().click();
  await expect(page.locator('.detail')).toContainText('Why these links');
});

test('record story: a flow run is linked by inference, with its evidence', async ({ page }) => {
  const flow = await openPolicyStoryWithFlow(page);
  await expect(flow.locator('.fui-Badge')).toContainText('≈');
  await flow.click();
  const panel = page.locator('.detail');
  await expect(panel).toContainText('rule I2');
  await expect(panel).toContainText('changed hbr_status, which it filters on');
  await expect(panel).toContainText('filter "hbr_premium gt 1000" is true');
  await page.getByRole('tab', { name: /Expected vs\. actual/ }).click();
  await expect(page.locator('table.expected')).toContainText('Notify underwriter on status change');
});

test('expected vs. actual: the rollup does not start the marketing flow (scenario 6)', async ({ page }) => {
  await openDemo(page, '/expected?t=account&c=update&cols=hbr_totalpremium');
  const row = page.locator('table.expected tr', { hasText: 'Sync account to marketing' });
  await expect(row).toContainText('not expected');
  await expect(row).toContainText('filters on name, telephone1, but the save changed hbr_totalpremium');
  await expect(page.locator('table.expected tr', { hasText: 'Harbor.Plugins.AccountRollup' })).toContainText('should run');
});

test('watch: a simulated save fills in the timeline as rows arrive', async ({ page }) => {
  await openDemo(page, '/watch');
  await pickRecord(page, 'hbr_policy', 'HP-10000');
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.locator('.watch-bar')).toContainText('Watching');
  await page.getByRole('button', { name: 'Simulate save' }).click();
  await expect(waterfallLabels(page).filter({ hasText: 'Update HP-10000 by Jamie Ortiz' })).toBeVisible({ timeout: 30_000 });
  await expect(waterfallLabels(page).filter({ hasText: 'PolicyErpSync' })).toBeVisible();
  // Flow run history arrives a few seconds after the run ends.
  await expect(waterfallLabels(page).filter({ hasText: 'Notify underwriter on status change' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Open record story' })).toBeVisible();
});

test('sessions: export a redacted record story and open it read-only', async ({ page }) => {
  await openPolicyStoryWithFlow(page);
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export session' });
  await expect(dialog.locator('.export-preview')).toContainText('"format": "dataverse-trace-session"');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^dvtrace-update-record-1-.*\.dvtrace\.json$/);
  const file = await download.path();

  await page.goto('/#/session');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose file' }).click()]);
  await chooser.setFiles(file);
  await expect(page.getByText('Redacted', { exact: true })).toBeVisible();
  await expect(waterfallLabels(page).filter({ hasText: 'Update Record 1 by User' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('HP-10000');
});

test('sessions: a file that is not a session is refused with a reason', async ({ page }) => {
  await page.goto('/#/session');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose file' }).click()]);
  await chooser.setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  await expect(page.getByText("This file can't be opened")).toBeVisible();
  await expect(page.getByText('This is not a Dataverse Trace session file.')).toBeVisible();
});
