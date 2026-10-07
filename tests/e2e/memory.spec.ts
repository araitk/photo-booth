import { writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

test.use({ reducedMotion: 'reduce' });

test('4K captures retain only thumbnail URLs after review and release undo history on the next capture', async ({ page }, testInfo) => {
  // Keep numeric metadata only so the probe does not extend the lifetime of a Blob.
  await page.addInitScript(() => {
    const active = new Map<string, { type: string; bytes: number }>();
    const pngBytes: number[] = [];
    const seen = new WeakSet<Blob>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => {
      const url = create(object);
      if (object instanceof Blob) {
        active.set(url, { type: object.type, bytes: object.size });
        if (object.type === 'image/png' && !seen.has(object)) {
          seen.add(object);
          pngBytes.push(object.size);
        }
      }
      return url;
    };
    URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
    Object.assign(window, { photoResourceProbe: () => ({
      urls: [...active.values()], pngBytes: [...pngBytes],
    }) });
  });
  const probe = () => page.evaluate(() => (window as unknown as {
    photoResourceProbe: () => { urls: { type: string; bytes: number }[]; pngBytes: number[] };
  }).photoResourceProbe());
  await page.goto('/');
  await page.getByRole('button', { name: 'カメラを開始', exact: true }).click();
  const shutter = page.locator('#shutter');
  await expect(shutter).toBeEnabled();
  await page.getByLabel('解像度', { exact: true }).selectOption('2160');
  await expect.poll(() => page.locator('#camera').evaluate((video: HTMLVideoElement) => [video.videoWidth, video.videoHeight])).toEqual([3840, 2160]);
  const count = 10;
  for (let number = 1; number <= count; number++) {
    await expect(shutter).toBeEnabled();
    await shutter.click();
    await expect(page.locator('.thumbnail')).toHaveCount(number);
  }
  const captured = await probe();
  expect(captured.pngBytes).toHaveLength(count);
  expect(captured.urls).toHaveLength(count);
  expect(captured.urls.every(url => url.type === 'image/jpeg')).toBe(true);
  await page.locator('.thumbnail').first().click();
  for (let remaining = count - 1; remaining >= 0; remaining--) {
    await page.locator('#delete-photo').click();
    await expect(page.locator('.thumbnail')).toHaveCount(remaining);
  }
  const deleted = await probe();
  expect(deleted.urls).toHaveLength(count);
  expect(deleted.pngBytes).toEqual(captured.pngBytes);
  await expect(page.locator('#undo-delete')).toBeEnabled();
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await expect(page.locator('.thumbnail')).toHaveCount(1);
  await expect(page.locator('#undo-delete')).toBeHidden();
  const recaptured = await probe();
  expect(recaptured.urls).toHaveLength(1);
  expect(recaptured.pngBytes).toHaveLength(count + 1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect((await probe()).urls).toHaveLength(0);
  const report = {
      dimensions: [3840, 2160], count,
      originalPngBytes: captured.pngBytes.reduce((sum, bytes) => sum + bytes, 0),
      thumbnailBytes: captured.urls.reduce((sum, url) => sum + url.bytes, 0),
      decodedRgbaBytesPerFrame: 3840 * 2160 * 4,
      urlsAfterCapture: captured.urls.length,
      urlsInUndoHistory: deleted.urls.length,
      urlsAfterNextCapture: recaptured.urls.length,
      urlsAfterPagehide: 0,
      scope: 'Encoded Blob sizes and URL lifetimes; excludes browser heap, video buffers and GPU memory. RGBA size is an estimate for one decoded frame.',
  };
  const path = testInfo.outputPath('4k-photo-resources.json');
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach('4k-photo-resources', { contentType: 'application/json', path });
});
