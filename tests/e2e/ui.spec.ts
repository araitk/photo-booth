import { test, expect } from './fixtures';

test('language and settings survive reload without opening the camera', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#start-camera')).toHaveText('カメラを開始');
  await page.getByLabel('言語', { exact: true }).selectOption('en');
  await page.getByLabel('Timer', { exact: true }).selectOption('5');
  await page.getByLabel('Resolution', { exact: true }).selectOption('720');
  await page.reload();
  await expect(page.locator('#start-camera')).toHaveText('Start camera');
  await expect(page.getByLabel('Timer', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720');
});

test('keyboard help opens and closes with focus restored to its trigger', async ({ page }) => {
  await page.goto('/');
  const trigger = page.locator('#show-shortcuts');
  await trigger.focus();
  await trigger.press('?');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#close-shortcuts')).toBeFocused();
  await page.locator('#close-shortcuts').press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(trigger).toBeFocused();
});
