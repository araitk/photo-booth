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

test('clicking the capture review restores live shooting before the return animation finishes', async ({ page }) => {
  await page.goto('/');
  await page.locator('#start-camera').click();
  const shutter = page.locator('#shutter');
  const review = page.locator('#photo-review');
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await expect(review).toBeVisible();
  await expect(page.locator('.returning-photo')).toHaveCount(1);
  await review.click();
  await expect(review).toBeHidden();
  await expect(shutter).toBeVisible();
  await expect(shutter).toBeEnabled();
  await expect(page.locator('.returning-photo')).toHaveCount(1);
  await shutter.click();
  await expect(page.locator('#photo-count')).toHaveText('2');
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`stop camera retains photos and allows restart at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const stop = page.getByRole('button', { name: 'カメラを停止', exact: true });
    await expect(stop).toBeHidden();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    const stopBox = (await stop.boundingBox())!;
    const fullscreenBox = (await page.locator('#fullscreen').boundingBox())!;
    expect(stopBox.x - (fullscreenBox.x + fullscreenBox.width)).toBe(16);
    expect(stopBox.y).toBe(fullscreenBox.y);
    await page.locator('#shutter').click();
    const photo = page.locator('.thumbnail').first();
    await expect(photo).toBeVisible();
    await expect(page.locator('#shutter')).toBeEnabled();
    await photo.click();
    const closePhoto = page.getByRole('button', { name: '写真を閉じる', exact: true });
    await expect(closePhoto).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('close-photo.png') });
    await closePhoto.click();
    await expect(page.locator('#captured-photo')).toBeHidden();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(stop).toBeVisible();
    await page.locator('#camera').evaluate((video: HTMLVideoElement) => {
      (window as unknown as { stoppedTrack: MediaStreamTrack }).stoppedTrack = (video.srcObject as MediaStream).getVideoTracks()[0];
    });
    await page.screenshot({ path: testInfo.outputPath('stop-button.png') });
    await stop.focus();
    await stop.press('Enter');
    await expect(page.locator('#start-camera')).toBeFocused();
    await expect(stop).toBeHidden();
    await expect(page.locator('#camera-message')).toHaveText('カメラは停止しています。');
    await expect(page.locator('#shutter')).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { stoppedTrack: MediaStreamTrack }).stoppedTrack.readyState)).toBe('ended');
    expect(await page.locator('#camera').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
    await photo.click();
    await expect(page.locator('#download-photo')).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-photo').click();
    await downloadPromise;
    await page.getByRole('button', { name: '写真を閉じる', exact: true }).click();
    await expect(page.locator('#close-preview')).toBeHidden();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(page.locator('.thumbnail')).toHaveCount(1);
    await page.locator('#timer').selectOption('3');
    await page.locator('#shutter').click();
    await expect(page.locator('#countdown')).toBeVisible();
    await stop.click();
    await expect(page.locator('#countdown')).toBeHidden();
    await page.locator('#language').selectOption('en');
    await expect(page.locator('#camera-message')).toHaveText('The camera is stopped.');
    await page.locator('#start-camera').click();
    await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  });
}

for (const width of [1280, 390]) {
  test(`mirror and grid control live preview and retain preferences at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const mirror = page.locator('#toggle-mirror');
    const grid = page.locator('#toggle-grid');
    const video = page.locator('#camera');
    await expect(mirror).toBeHidden();
    await expect(grid).toBeHidden();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(mirror).toHaveAttribute('aria-pressed', 'true');
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    await expect(video).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    await expect(page.locator('.grid')).toBeVisible();
    const trackId = await video.evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks()[0].id);
    const buttons = page.locator('.preview-tools button');
    expect(await buttons.evaluateAll(nodes => nodes.map(node => node.id))).toEqual(['toggle-mirror', 'toggle-grid', 'fullscreen', 'close-preview']);
    const boxes = await Promise.all([0, 1, 2, 3].map(index => buttons.nth(index).boundingBox()));
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index]!.y).toBe(boxes[0]!.y);
      expect(boxes[index - 1]!.x + boxes[index - 1]!.width).toBeLessThan(boxes[index]!.x);
    }
    expect(boxes[3]!.x - (boxes[2]!.x + boxes[2]!.width)).toBe(16);
    await page.screenshot({ path: testInfo.outputPath('preview-tools.png') });
    await mirror.focus(); await mirror.press('Enter');
    await expect(mirror).toBeFocused();
    await grid.click();
    await expect(video).toHaveCSS('transform', 'none');
    await expect(page.locator('.grid')).toBeHidden();
    expect(await video.evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks()[0].id)).toBe(trackId);
    await page.locator('#language').selectOption('en');
    await expect(mirror).toHaveAttribute('title', 'Turn mirror preview on');
    await expect(grid).toHaveAttribute('title', 'Turn grid overlay on');
    await mirror.click(); await grid.click();
    await page.locator('#shutter').click();
    await expect(page.locator('.thumbnail')).toHaveCount(1);
    await expect(page.locator('#shutter')).toBeEnabled();
    await page.locator('.thumbnail').click();
    await expect(mirror).toBeHidden();
    await expect(grid).toBeHidden();
    await expect(page.locator('#captured-photo')).toHaveCSS('transform', 'none');
    await page.getByRole('button', { name: 'Close photo', exact: true }).click();
    await page.locator('#timer').selectOption('3');
    await page.locator('#shutter').click();
    await expect(page.locator('#countdown')).toBeVisible();
    await mirror.click(); await grid.click();
    await expect(video).toHaveCSS('transform', 'none');
    await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await expect(mirror).toBeHidden();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(mirror).toHaveAttribute('aria-pressed', 'false');
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(mirror).toBeHidden();
    await page.locator('#start-camera').click();
    await expect(page.locator('#shutter')).toBeEnabled();
    await expect(mirror).toHaveAttribute('aria-pressed', 'false');
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.grid')).toBeHidden();
    await expect(video).toHaveCSS('transform', 'none');
  });
}
