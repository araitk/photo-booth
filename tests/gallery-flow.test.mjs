import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup({ deferPng = false } = {}) {
  const elements = new Map();
  let finishAnimation;
  let nextUrl = 0;
  const activeUrls = new Map();
  const encodings = [];
  const pending = [];
  function element() {
    return {
      value: '1080', readyState: 2, videoWidth: 1920, videoHeight: 1080,
      clientWidth: 1200, clientHeight: 675, hidden: false, disabled: false,
      style: {}, dataset: {}, children: [], scrollLeft: 0,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      querySelectorAll() { return this.children; },
      querySelector() { return null; },
      getBoundingClientRect: () => ({ left: 100, top: 600, width: 96, height: 54 }),
      async decode() { this.decoded = true; },
      getContext() { return { drawImage() {} }; },
      toBlob(callback, type) {
        if (deferPng && type === "image/png") { pending.push({ canvas: this, callback }); return; }
        const result = new Blob([type], { type });
        encodings.push({ canvas: this, callback, result });
        callback(result);
      },
      animate(_frames, options) {
        assert([180, 1000].includes(options.duration));
        return { finished: new Promise(resolve => { finishAnimation = resolve; }), cancel() {} };
      },
    };
  }
  const document = {
    fullscreenEnabled: false, fullscreenElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: () => element(), createTextNode: text => text,
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
  };
  const context = vm.createContext({
    document, navigator: {},
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    ResizeObserver: class { observe() {} },
    URL: {
      createObjectURL(blob) { const url = `blob:${++nextUrl}`; activeUrls.set(url, blob); return url; },
      revokeObjectURL(url) { activeUrls.delete(url); },
    },
    Date, Blob, setTimeout, clearTimeout, DOMException,
  });
  for (const file of ['photo-store.ts', 'return-effects.ts', 'main.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(compiled, context);
  }
  const run = source => vm.runInContext(source, context);
  return { elements, context, run, finish: () => finishAnimation(), document, activeUrls, encodings, pending };
}

test('append each thumbnail and update count only after the return animation finishes', async () => {
  const { elements, run, finish } = setup();
  try {
    for (let count = 1; count <= 2; count++) {
      run('photos.add(new Blob(["png"], {type:"image/png"}), new Blob(["jpg"], {type:"image/jpeg"}), 1920, 1080);');
      await run(`showPhoto(photos.get(${count}), true)`);
      const preparedImage = run(`thumbnailImages.get(${count})`);
      assert.equal(preparedImage.decoded, true);
      assert.equal(elements.get('#photo-count').textContent, String(count - 1));
      assert.equal(elements.get('#gallery-list').children.length, count - 1);
      const returning = run('returnToCamera()');
      assert.equal(elements.get('#photo-count').textContent, String(count - 1));
      assert.equal(elements.get('#gallery-list').children.length, count - 1);
      finish();
      await returning;
      assert.equal(elements.get('#photo-count').textContent, String(count));
      assert.equal(elements.get('#gallery-list').children.length, count);
      assert.equal(elements.get('#gallery-list').children[0].dataset.photoId, String(count));
      assert.equal(elements.get('#gallery-list').children[0].children[0], preparedImage);
      if (count > 1) {
        assert.equal(elements.get('#gallery-list').children[1].children[0], run('thumbnailImages.get(1)'));
      }
      assert.equal(elements.get('#gallery-list').scrollLeft, 0);
    }
  } finally {
    run('clearPhoto(); photos.clear();');
  }
});


test('countdown captures once at the deadline, supports cancellation, and resets with the camera', () => {
  const { elements, context, run, document } = setup();
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  context.Date = class extends Date { static now() { return now; } };
  context.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  context.clearTimeout = id => timers.delete(id);
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
    var captures = 0;
    capturePhoto = () => { captures++; capturePhase = 'capturing'; setBusy(false); };
    setBusy(false);`);
  const timer = elements.get('#timer');
  const countdown = elements.get('#countdown');
  const shutter = elements.get('#shutter');
  for (const seconds of [3, 5, 10]) {
    run("clearPhoto(); captures = 0;");
    timer.value = String(seconds);
    run('startShooting()');
    assert.equal(countdown.textContent, String(seconds));
    assert.equal(countdown.hidden, false);
    assert.equal(shutter['aria-label'], '撮影をキャンセル');
    assert.equal(timer.disabled, true);
    assert.equal(elements.get('#resolution').disabled, true);
    advance(1000);
    assert.equal(countdown.textContent, String(seconds - 1));
    advance((seconds - 1) * 1000 - 1);
    assert.equal(run('captures'), 0);
    advance(1);
    assert.equal(run('captures'), 1);
    assert.equal(countdown.hidden, true);
    run('startShooting()');
    advance(2000);
    assert.equal(run('captures'), 1);
  }
  for (const cancel of [
    () => run('startShooting()'),
    () => document.listeners.get('keydown')({ key: 'Escape' }),
    () => { document.hidden = true; document.listeners.get('visibilitychange')(); },
    () => run('resetCamera()'),
  ]) {
    run("clearPhoto(); captures = 0; stream = {getTracks: () => []}; setBusy(false);");
    timer.value = '3';
    run('startShooting()');
    advance(1000);
    cancel();
    assert.equal(countdown.hidden, true);
    advance(5000);
    assert.equal(run('captures'), 0);
    assert.equal(timers.size, 0);
  }
  run('stream = {getTracks: () => []}; setBusy(false);');
  timer.value = '0';
  run('startShooting()');
  assert.equal(run('captures'), 1);
  assert.equal(countdown.hidden, true);
});

test('100 captures retain only thumbnails URLs and release originals, images, downloads after deletion', async () => {
  const { run, activeUrls, encodings, elements } = setup();
  run(`reducedMotion.matches = true;
    stream = { getTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({}) }] };
    setBusy(false);`);
  try {
    for (let count = 1; count <= 100; count++) {
      await run('capturePhoto()');
      assert.equal(run('photos.list().length'), count);
      assert.equal(activeUrls.size, count + 1); // Thumbnails plus the selected original.
      assert.equal(run('photos.list()[0].width'), 1920);
      assert.equal(run('photos.list()[0].height'), 1080);
      await run('returnToCamera()');
      assert.equal(activeUrls.size, count);
      assert.equal(run('thumbnailImages.size'), count);
      assert.equal(elements.get('#gallery-list').children.length, count);
      assert.equal(run('animations.length'), 0);
    }
    for (const { canvas } of encodings) {
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
    }
    for (let remaining = 100; remaining > 0; remaining--) {
      await run('showPhoto(photos.list()[0])');
      run(`var downloadUrl = URL.createObjectURL(photos.get(selectedPhotoId).original);
        downloads.set(downloadUrl, { photoId: selectedPhotoId, timer: setTimeout(() => releaseDownload(downloadUrl), 60000) });
        deleteSelectedPhoto();`);
      assert.equal(run('photos.list().length'), remaining - 1);
      assert.equal(run('thumbnailImages.size'), remaining - 1);
      assert.equal(run('downloads.size'), 0);
      assert.equal(activeUrls.size, remaining - 1);
    }
    assert.equal(elements.get('#gallery-list').children.length, 0);
    assert.equal(elements.get('#captured-photo').src, undefined);
  } finally {
    run('clearPhoto(); photos.clear(); for (const url of downloads.keys()) releaseDownload(url);');
  }
});

test('a capture completing after disconnect does not clear a new capture canvas', async () => {
  const { run, activeUrls, pending } = setup({ deferPng: true });
  const connect = () => run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]}; setBusy(false);`);
  connect();
  const first = run('capturePhoto()');
  run('resetCamera()');
  connect();
  const second = run('capturePhoto()');
  try {
    pending[0].callback(new Blob(['old'], { type: 'image/png' }));
    await first;
    assert.equal(pending[1].canvas.width, 1920);
    assert.equal(pending[1].canvas.height, 1080);
    pending[1].callback(new Blob(['new'], { type: 'image/png' }));
    await second;
    assert.equal(run('photos.list().length'), 1);
    assert.equal(run('photos.list()[0].original.size'), 3);
  } finally {
    run('clearPhoto(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});
