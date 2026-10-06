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
  const middle = thumbnails.nth(1);
  await expect(middle).toHaveAttribute('aria-pressed', 'true');
  await expect(middle).toBeFocused();
  await expect(page.locator('.thumbnail[tabindex="0"]')).toHaveCount(1);
  await middle.press('s');
  await expect(middle).toHaveAttribute('data-downloaded', 'true');
  await expect(middle).toBeFocused();
  await page.locator('#download-photo').focus();
  await expect(middle).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#download-photo').press('Tab');
  await expect(page.locator('#delete-photo')).toBeFocused();
  await page.locator('#delete-photo').press('Tab');
  await expect(middle).toBeFocused();
  await middle.press('Tab');
  await expect(page.locator('.project-footer a')).toBeFocused();
  await expect(middle).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.project-footer a').press('Shift+Tab');
  await expect(middle).toBeFocused();
  await middle.press('Delete');
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.first()).toBeFocused();
  await thumbnails.first().press('z');
  await expect(thumbnails).toHaveCount(3);
  await expect(thumbnails.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbnails.nth(1)).toBeFocused();
  await thumbnails.nth(1).press('Escape');
  await expect(page.locator('#captured-photo')).toBeHidden();
  await thumbnails.nth(1).press('ArrowLeft');
  await expect(thumbnails.last()).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbnails.last()).toBeFocused();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`photos remain available after camera disconnects at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('#start-camera').click();
    const thumbnails = page.locator('.thumbnail');
    await expect(page.locator('#shutter')).toBeEnabled();
    await page.locator('#shutter').click();
    await expect(thumbnails).toHaveCount(1);
    await expect(page.locator('#shutter')).toBeEnabled();
    await page.locator('#camera').evaluate((video: HTMLVideoElement) => {
      const track = (video.srcObject as MediaStream).getVideoTracks()[0];
      track.stop();
      // stop() does not emit ended; dispatch the event used for device disconnection.
      track.dispatchEvent(new Event('ended'));
    });
    await expect(page.locator('#camera-message')).toHaveText('カメラとの接続が切れました。もう一度開始してください。');
    await expect(thumbnails.first()).toBeVisible();
    await expect(page.locator('#shutter')).toBeHidden();
    const screenshot = testInfo.outputPath('disconnected.png');
    await page.screenshot({ path: screenshot });
    await thumbnails.first().click();
    await expect(page.locator('#captured-photo')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-photo').click();
    const download = await downloadPromise;
    const png = await readFile((await download.path())!);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await expect(thumbnails.first()).toHaveAttribute('data-downloaded', 'true');
    await thumbnails.first().focus();
    await thumbnails.first().press('Delete');
    await expect(thumbnails).toHaveCount(0);
    await expect(page.locator('#start-camera')).toBeFocused();
    await expect(page.locator('#start-camera')).toBeVisible();
    await expect(page.locator('#undo-delete')).toBeVisible();
    await page.locator('#undo-delete').click();
    await expect(thumbnails).toHaveCount(1);
    await expect(page.locator('#captured-photo')).toBeVisible();
    await page.locator('#photo-review').click();
    await expect(page.locator('#start-camera')).toBeVisible();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(thumbnails).toHaveCount(1);
  });
}

test('deleting a focused thumbnail moves focus to the selected neighbor then the shutter', async ({ page }) => {
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
  await thumbnails.nth(1).focus();
  await thumbnails.nth(1).press('Enter');
  await expect(thumbnails.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await thumbnails.nth(1).press('Delete');
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbnails.first()).toBeFocused();
  await thumbnails.first().press('Delete');
  await expect(thumbnails).toHaveCount(1);
  await expect(thumbnails.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbnails.first()).toBeFocused();
  await thumbnails.first().press('Delete');
  await expect(thumbnails).toHaveCount(0);
  await expect(shutter).toBeFocused();
  await shutter.press('Space');
  await expect(thumbnails).toHaveCount(1);
});
