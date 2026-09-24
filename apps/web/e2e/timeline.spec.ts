// v0.3 timeline tools: collapse to a depth, filter inferred links, critical path, minimap.
import { expect, test, type Page } from '@playwright/test';
import { openDemo, openPolicyStoryWithFlow, waterfallLabels } from './helpers.ts';

async function openFirst(page: Page, query: string) {
  await openDemo(page, `/explorer?r=all&q=${encodeURIComponent(query)}`);
  await page.getByRole('grid', { name: 'Results' }).getByRole('row').first().dblclick();
  await expect(page).toHaveURL(/#\/trace\//);
  await expect(waterfallLabels(page).first()).toBeVisible();
}

test('timeline: collapse the update loop below a depth, then expand it again', async ({ page }) => {
  await openFirst(page, 'depth>=6');
  const all = await waterfallLabels(page).count();
  await page.getByRole('button', { name: 'All depths' }).click();
  await page.getByRole('menuitemradio', { name: 'Collapse below depth 2' }).click();
  await expect(page.getByRole('button', { name: 'Down to depth 2' })).toBeVisible();
  expect(await waterfallLabels(page).count()).toBeLessThan(all);
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(waterfallLabels(page)).toHaveCount(all);
});

test('timeline: the critical path of a slow save says where the time went', async ({ page }) => {
  await openFirst(page, 'table:hbr_policy msg:Update dur>3s');
  await page.getByRole('button', { name: 'Critical path' }).click();
  const summary = page.locator('.wf-critical');
  await expect(summary).toContainText('Critical path,');
  await expect(summary).toContainText('PolicyErpSync');
  await expect(page.locator('.wf-lane.critical').first()).toBeVisible();

  // Drag across the start of the minimap to zoom there; "Fit" undoes it.
  const box = (await page.locator('.wf-minimap').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.02, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.wf-minimap-window')).toBeVisible();
  await page.getByRole('button', { name: 'Fit (or double-click a row to zoom to it)' }).click();
  await expect(page.locator('.wf-minimap-window')).toHaveCount(0);
});

test('timeline: inferred links can be hidden below a confidence', async ({ page }) => {
  await openPolicyStoryWithFlow(page);
  const flow = waterfallLabels(page).filter({ hasText: 'Notify underwriter on status change' });
  await expect(flow).toBeVisible();
  await page.getByRole('button', { name: 'All links' }).click();
  await page.getByRole('menuitemradio', { name: 'Hide every inferred link' }).click();
  await expect(flow).toHaveCount(0);
  await expect(page.getByText(/hidden by the link filter/)).toBeVisible();
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(flow).toBeVisible();
});
