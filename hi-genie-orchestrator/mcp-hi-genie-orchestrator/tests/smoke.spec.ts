import { expect, test } from '@playwright/test';

const pages = [
  ['/', 'Overview'],
  ['/workstreams', 'Workstreams'],
  ['/graph', 'Dependency graph'],
  ['/reviews', 'Reviews'],
  ['/sessions', 'Sessions'],
  ['/system', 'System'],
] as const;

test('Release 1 shell exposes stable read-only navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Primary navigation').getByText('Hi Genie')).toBeVisible();
  await expect(page.getByText('Read only')).toBeVisible();
  for (const [, heading] of pages) {
    await expect(page.getByRole('link', { name: heading === 'Dependency graph' ? 'Graph' : heading })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Attention queue')).toBeVisible();
});

for (const [path, heading] of pages) {
  test(`${heading} view loads fixture data`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByLabel('Current orchestration scope')).toContainText('orch-r1-readiness');
  });
}

test('graph offers an equivalent keyboard-accessible list', async ({ page }) => {
  await page.goto('/graph');
  await page.getByRole('button', { name: 'Accessible list' }).click();
  await expect(page.getByRole('heading', { name: 'Dependency list' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('WS-A');
  await expect(page.getByRole('table')).toContainText('ws-0');
  await page.getByRole('button', { name: 'Graph' }).click();
  await expect(page.getByRole('img', { name: 'Workstream dependency graph' })).toBeVisible();
});

test('workstreams can be searched and filtered', async ({ page }) => {
  await page.goto('/workstreams');
  await page.getByPlaceholder('Name, key, or ID').fill('security');
  await expect(page.getByRole('table')).toContainText('Security review');
  await expect(page.getByRole('table')).not.toContainText('Operational UI');
});

test('theme preference is persisted locally', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Use (light|dark) theme/ })
    .first()
    .click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme ?? 'light');
});

test('loading state is announced while a fixture read remains pending', async ({ page }) => {
  await page.goto('/system?fixtureState=loading');
  await expect(page.getByLabel('Loading data')).toHaveAttribute('aria-busy', 'true');
});

test('error state is announced for a failed fixture read', async ({ page }) => {
  await page.goto('/reviews?fixtureState=error');
  await expect(page.getByRole('alert')).toContainText('Unable to load this read model');
  await expect(page.getByRole('alert')).toContainText('Fixture read model request failed');
});

test('empty state is shown for an empty fixture collection', async ({ page }) => {
  await page.goto('/workstreams?fixtureState=empty');
  await expect(page.getByRole('heading', { name: 'No records found' })).toBeVisible();
});
