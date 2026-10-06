import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

test('capture, review, download, deletion and undo work with real media and animation APIs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'カメラを開始', exact: true }).click();
  const shutter = page.locator('#shutter');
  const thumbnails = page.locator('.thumbnail');
  await expect(shutter).toBeEnabled();
  for (let count = 1; count <= 2; count++) {
    await shutter.click();
    await expect(thumbnails).toHaveCount(count);
    await expect(shutter).toBeEnabled();
  }
  await thumbnails.last().click();
  await expect(page.locator('#captured-photo')).toBeVisible();
  await expect(page.locator('#photo-position')).toHaveText('1 / 2');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-photo').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^photo-\d{8}-\d{6}\.png$/);
  const png = await readFile((await download.path())!);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const dimensions = await page.locator('#camera').evaluate((video: HTMLVideoElement) => [video.videoWidth, video.videoHeight]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(dimensions);
  await expect(thumbnails.last()).toHaveAttribute('data-downloaded', 'true');
  await page.locator('#delete-photo').click();
  await expect(thumbnails).toHaveCount(1);
  await page.locator('#undo-delete').click();
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.last()).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbnails.last()).toHaveAttribute('data-downloaded', 'true');
  await expect(page.locator('#captured-photo')).toBeVisible();
});
