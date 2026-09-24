// v0.3: the observed cascade graph and its loops.
import { expect, test } from '@playwright/test';
import { openDemo } from './helpers.ts';

test('cascades: the update loop is found, and one of its operations opens as a trace', async ({ page }) => {
  await openDemo(page, '/dashboard?r=7d');
  await page.locator('.finding', { hasText: 'trigger each other' }).getByRole('button', { name: 'See the loop in Cascades →' }).click();
  await expect(page).toHaveURL(/#\/graph/);
  const side = page.locator('.graph-side');
  await expect(side).toContainText('A loop between 3 steps');
  await expect(side).toContainText('Harbor.Plugins.ContactSyncToAccount');
  await expect(page.getByRole('button', { name: /Harbor\.Plugins\.AccountContactCount, Update account/ })).toBeVisible();

  // Selecting a step shows what it causes.
  await page.getByRole('button', { name: /Harbor\.Plugins\.PolicyPostCreate, Create hbr_policy/ }).click();
  await expect(side).toContainText('Causes');
  await expect(side).toContainText('Harbor.Plugins.AccountRollup');

  // Uncertain links are hidden until asked for; the table view lists the links.
  await expect(page.getByText(/uncertain links? (is|are) hidden/)).toBeVisible();
  await page.getByRole('switch', { name: 'Table' }).click();
  await expect(page.getByRole('table', { name: 'Cascade links' })).toContainText('Harbor.Plugins.AccountRollup');

  await side.locator('.cycle a').first().click();
  await expect(page).toHaveURL(/#\/trace\//);
  await expect(page.locator('.trace-summary')).toContainText('Max depth');
});

test('cascades: filtering by table keeps that table\'s steps and their neighbours', async ({ page }) => {
  await openDemo(page, '/graph?t=hbr_policy');
  await expect(page.getByRole('button', { name: /Harbor\.Plugins\.PolicyPostCreate/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Harbor\.Plugins\.AccountRollup/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Harbor\.Plugins\.ContactAudit/ })).toHaveCount(0);
  await expect(page.locator('.graph-side')).not.toContainText('A loop between');
});
