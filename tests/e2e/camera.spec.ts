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
  expect(download.suggestedFilename()).toMatch(/^photo-\d{8}-\d{6}-\d{2}\.png$/);
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

test('gallery keyboard selection keeps focus through photo loading and updates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#start-camera').click();
  const shutter = page.locator('#shutter');
  const thumbnails = page.locator('.thumbnail');
  await expect(shutter).toBeEnabled();
  for (let count = 1; count <= 3; count++) {
    await shutter.click();
    await expect(thumbnails).toHaveCount(count);
    await expect(shutter).toBeEnabled();
  }
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    let delayNextPhoto = true;
    HTMLImageElement.prototype.decode = function () {
      const decoded = decode.call(this);
      if (this.id !== 'captured-photo' || !delayNextPhoto) return decoded;
      delayNextPhoto = false;
      return Promise.all([decoded, new Promise<void>(resolve => {
        document.addEventListener('release-photo-decode', () => resolve(), { once: true });
      })]).then(() => undefined);
    };
  });
  const oldest = thumbnails.last();
  await oldest.focus();
  await oldest.press('Enter');
  await expect(oldest).toHaveAttribute('aria-disabled', 'true');
  await expect(oldest).toBeFocused();
  await oldest.press('Enter');
  await page.evaluate(() => document.dispatchEvent(new Event('release-photo-decode')));
  await expect(oldest).toHaveAttribute('aria-pressed', 'true');
  await expect(oldest).toBeFocused();
  await oldest.press('ArrowRight');
  await expect(thumbnails.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(oldest).toBeFocused();
  await oldest.press('s');
  await expect(thumbnails.nth(1)).toHaveAttribute('data-downloaded', 'true');
  await expect(oldest).toBeFocused();
  await oldest.press('Delete');
  await expect(thumbnails).toHaveCount(2);
  await expect(oldest).toBeFocused();
  await oldest.press('z');
  await expect(thumbnails).toHaveCount(3);
  await expect(oldest).toBeFocused();
});
