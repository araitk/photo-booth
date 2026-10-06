import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compiledModules = new Map();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

async function setup({ deferPng = false, storage = new Map(), storageBlocked = false,
  browserLanguage = 'ja-JP', reducedMotion = false, unsupported = false } = {}) {
  const elements = new Map(), activeUrls = new Map(), timers = new Map();
  const animations = [], pending = [], encodings = [], requests = [], tracks = [], clickedDownloads = [];
  const motion = { matches: reducedMotion };
  let nextUrl = 0, nextTimer = 0, now = 0;
  let document;
  function element(tag = 'div') {
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(), value: '', readyState: 2, videoWidth: 1920, videoHeight: 1080,
      clientWidth: 1200, clientHeight: 675, hidden: false, disabled: false,
      style: {}, dataset: {}, children: [], scrollLeft: 0, listeners: new Map(),
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); } },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      replaceChildren(...children) { for (const child of this.children) if (typeof child === 'object') child.parent = undefined; this.children = []; this.append(...children); },
      append(...children) { for (const child of children) { if (typeof child === 'object') { child.remove(); child.parent = this; } this.children.push(child); } },
      cloneNode(deep) { const copy = Object.assign(element(tag), { src: this.src, alt: this.alt, id: this.id, className: this.className }); if (deep) copy.append(...this.children.map(child => typeof child === 'object' ? child.cloneNode(true) : child)); return copy; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; } },
      click() { if (tag === 'a') clickedDownloads.push({ href: this.href, download: this.download }); this.listeners.get('click')?.({ detail: 0 }); },
      blur() { this.blurred = true; }, scrollIntoView(options) { this.scrollOptions = options; },
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.get('close')?.(); },
      closest(selector) { return selector.includes(tag) ? this : null; },
      querySelectorAll(selector) { return this.children.filter(child => typeof child === 'object' && (selector === '.thumbnail' ? child.className === 'thumbnail' : true)); },
      querySelector(selector) { const match = selector.match(/data-photo-id="(\d+)"/); return match ? this.children.find(child => child.dataset?.photoId === match[1]) ?? null : null; },
      getBoundingClientRect() { return { left: this.parent?.children.indexOf(this) * 104 || 100, top: 600, width: 96, height: 54 }; },
      async play() {}, async decode() { this.decoded = true; },
      getContext() { return { drawImage() {} }; },
      toBlob(callback, type) {
        encodings.push(this);
        if (deferPng && type === 'image/png') { pending.push({ canvas: this, callback }); return; }
        callback(new Blob([type], { type }));
      },
      animationCalls: [],
      animate(frames, options) {
        const completion = deferred();
        const animation = { element: this, frames, options, finished: completion.promise, cancelled: false,
          settled: false, finish() { this.settled = true; completion.resolve(); }, cancel() { this.cancelled = true; completion.reject(new Error('cancelled')); } };
        this.animationCalls.push(animation); animations.push(animation); return animation;
      },
      async requestFullscreen() { document.fullscreenElement = this; document.listeners.get('fullscreenchange')?.(); },
    };
    return node;
  }
  document = {
    body: element('body'), documentElement: {}, listeners: new Map(), hidden: false,
    fullscreenEnabled: true, fullscreenElement: null, querySelectorAll: () => [],
    querySelector(selector) {
      if (!elements.has(selector)) {
        const tag = selector === '#camera' ? 'video' : ['#resolution', '#camera-select', '#language', '#timer'].includes(selector) ? 'select' : selector === '#captured-photo' ? 'img' : 'div';
        const node = element(tag);
        if (selector === '#resolution') node.value = '1080';
        if (selector === '#timer') node.value = '0';
        if (selector === '#photo-review') node.hidden = true;
        elements.set(selector, node);
      }
      return elements.get(selector);
    },
    createElement: tag => element(tag), createTextNode: text => text,
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    async exitFullscreen() { this.fullscreenElement = null; this.listeners.get('fullscreenchange')?.(); },
  };
  const window = { listeners: new Map(), matchMedia: () => motion,
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); } };
  const mediaDevices = { listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'built-in', label: '内蔵カメラ'}, {kind: 'videoinput', deviceId: 'usb', label: 'USBカメラ'}, {kind: 'audioinput', deviceId: 'mic'}],
    async getUserMedia(options) { requests.push(options); return makeStream(options.video.deviceId?.exact || 'built-in'); },
  };
  function makeStream(id = 'built-in') {
    let settings = {deviceId: id, width: 1920, height: 1080, frameRate: 30};
    const track = { stopped: false, listeners: new Map(), stop() { this.stopped = true; },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      getSettings: () => settings, getConstraints: () => ({}),
      async applyConstraints(value) { if (value.height?.exact) settings = {...settings, width: value.width.exact, height: value.height.exact}; } };
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  }
  const context = vm.createContext({ document, window, navigator: {language: browserLanguage, mediaDevices: unsupported ? undefined : mediaDevices},
    localStorage: { getItem(key) { if (storageBlocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('blocked'); storage.set(key, value); } },
    ResizeObserver: class { observe() {} }, Blob, DOMException,
    Date: class extends Date { static now() { return now; } },
    URL: { createObjectURL(blob) { const url = `blob:${++nextUrl}`; activeUrls.set(url, blob); return url; }, revokeObjectURL: url => activeUrls.delete(url) },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, deadline: now + delay}); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    if (!compiledModules.has(name)) compiledModules.set(name, ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
      {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText);
    const module = {exports: {}};
    modules.set(name, module);
    const evaluate = vm.runInContext(`(function(require, module, exports) { ${compiledModules.get(name)}\n})`, context);
    evaluate(specifier => load(specifier.replace('./', '')), module, module.exports);
    return module.exports;
  }
  const app = load('main');
  const el = selector => document.querySelector(selector);
  async function change(selector, value) { el(selector).value = value; await el(selector).listeners.get('change')(); await flush(); }
  async function press(key, extra = {}) {
    let prevented = false;
    document.listeners.get('keydown')({key, preventDefault() { prevented = true; }, ...extra});
    await flush(); return prevented;
  }
  async function advance(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.deadline <= now && timers.delete(id)) timer.callback();
    await flush();
  }
  function addPhoto(label = 'png') { return app.photos.add(new Blob([label]), new Blob(['jpg']), 1920, 1080); }
  function redraw() {
    const state = app.capture.getState();
    app.view.renderGallery(app.photos.list(), state.selectedPhotoId, state.pendingPhotoId, app.capture.getActions().galleryLocked);
  }
  const returning = () => el('#media-surface').children.filter(node => node.className === 'photo-review returning-photo');
  const preview = () => el('#photo-review').children[0];
  async function close() {
    window.listeners.get('pagehide')({persisted: false}); await flush();
    assert.equal(activeUrls.size, 0);
    assert.equal(timers.size, 0);
  }
  await flush();
  return {...app, context, document, window, mediaDevices, el, change, press, advance, addPhoto, redraw,
    returning, preview, close, load, activeUrls, animations, pending, encodings, requests, tracks, makeStream, storage, motion, timers};
}

const savedKey = 'photo-booth.settings.v1';
const ids = f => f.el('#gallery-list').children.map(button => Number(button.dataset.photoId));

// Assertions use controller operations, read-only snapshots, and the rendered DOM.
test('camera selection lists video inputs, switches devices, and restores the original stream on failure', async () => {
  const f = await setup();
  try {
    assert.deepEqual(f.el('#camera-select').children.map(option => option.value), ['', 'built-in', 'usb']);
    await f.camera.openCamera();
    const first = f.camera.getState().stream;
    assert.equal(f.requests[0].audio, false);
    await f.change('#camera-select', 'usb');
    assert.equal(f.tracks[0].stopped, true);
    const active = f.camera.getState().stream;
    f.mediaDevices.getUserMedia = async () => { throw new DOMException('', 'NotReadableError'); };
    await f.change('#camera-select', 'built-in');
    assert.equal(f.camera.getState().stream, active);
    assert.equal(f.el('#camera').srcObject, active);
    assert.notEqual(active, first);
    assert.match(f.el('#status').textContent, /元のカメラ/);
  } finally { await f.close(); }
});

test('camera changes during capture wait for return completion and apply only the latest choice', async () => {
  const f = await setup({deferPng: true});
  try {
    await f.camera.openCamera();
    const capturing = f.capture.capturePhoto();
    await f.change('#camera-select', 'usb');
    await f.change('#camera-select', 'built-in');
    assert.equal(f.requests.length, 1);
    f.pending[0].callback(new Blob(['png'])); await capturing;
    assert.equal(f.capture.getState().capturePhase, 'returning');
    assert.equal(f.requests.length, 1);
    f.returning()[0].animationCalls[0].finish(); await flush();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].video.deviceId.exact, 'built-in');
    assert.equal(f.capture.getState().capturePhase, 'live');
  } finally { await f.close(); }
});

test('saved camera preferences survive hidden devices and reset after an unavailable device is identified', async () => {
  const f = await setup({storage: new Map([[savedKey, JSON.stringify({cameraId: 'usb'})]])});
  try {
    f.mediaDevices.enumerateDevices = async () => [];
    await f.camera.updateCameraList();
    assert.equal(f.camera.getState().preferredCameraId, 'usb');
    f.mediaDevices.enumerateDevices = async () => [{kind: 'videoinput', deviceId: 'built-in', label: '内蔵'}];
    await f.camera.updateCameraList();
    assert.equal(f.camera.getState().preferredCameraId, '');
    assert.equal(JSON.parse(f.storage.get(savedKey)).cameraId, '');
  } finally { await f.close(); }
});

test('a missing saved camera falls back to automatic and persists the camera actually used', async () => {
  const f = await setup({storage: new Map([[savedKey, JSON.stringify({cameraId: 'usb'})]])});
  try {
    f.mediaDevices.getUserMedia = async options => {
      f.requests.push(options);
      if (options.video.deviceId) throw new DOMException('', 'NotFoundError');
      return f.makeStream('built-in');
    };
    await f.camera.openCamera();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].video.deviceId, undefined);
    assert.equal(JSON.parse(f.storage.get(savedKey)).cameraId, 'built-in');
  } finally { await f.close(); }
});

test('resolution rollback and timer preferences persist without replacing the photo preview', async () => {
  const f = await setup({storage: new Map([[savedKey, JSON.stringify({timer: '5', resolution: '1080'})]])});
  try {
    await f.camera.openCamera();
    await f.capture.showPhoto(f.addPhoto());
    const image = f.preview();
    await f.change('#timer', '10');
    await f.change('#resolution', '720');
    const track = f.tracks[0], apply = track.applyConstraints;
    track.applyConstraints = async value => { if (value.height?.exact === 2160) throw new Error('unsupported'); return apply(value); };
    await f.change('#resolution', '2160');
    assert.equal(f.camera.getState().appliedResolution, '720');
    assert.equal(f.el('#resolution').value, '720');
    assert.equal(f.preview(), image);
    const reloaded = await setup({storage: f.storage});
    assert.equal(reloaded.el('#timer').value, '10');
    assert.equal(reloaded.el('#resolution').value, '720');
    await reloaded.close();
  } finally { await f.close(); }
});

test('rapid resolution changes apply the latest choice while controls remain enabled', async () => {
  const f = await setup();
  try {
    assert.equal(f.el('#resolution').disabled, false);
    await f.camera.openCamera();
    await f.capture.showPhoto(f.addPhoto());
    const image = f.preview(), applied = [], first = deferred();
    f.tracks[0].applyConstraints = async value => { applied.push(value.height.exact); if (applied.length === 1) await first.promise; };
    const changing = f.camera.selectResolution('720');
    await f.change('#resolution', '2160');
    assert.equal(f.el('#resolution').disabled, false);
    assert.equal(f.el('#timer').disabled, false);
    first.resolve(); await changing; await flush();
    assert.deepEqual(applied, [720, 2160]);
    assert.equal(f.camera.getState().appliedResolution, '2160');
    assert.equal(f.preview(), image);
  } finally { await f.close(); }
});

test('language respects browser defaults and saved choices, including blocked or invalid storage', async () => {
  for (const [options, expected] of [
    [{browserLanguage: 'ja-JP'}, 'ja'], [{browserLanguage: 'en-US'}, 'en'],
    [{browserLanguage: 'en-US', storage: new Map([[savedKey, JSON.stringify({language: 'ja'})]])}, 'ja'],
    [{browserLanguage: 'en-US', storage: new Map([[savedKey, 'invalid']])}, 'en'],
    [{browserLanguage: 'en-US', storageBlocked: true}, 'en'],
  ]) {
    const f = await setup(options);
    assert.equal(f.load('i18n').getLanguage(), expected);
    await f.close();
  }
});

test('changing language updates errors and photo metadata without interrupting the preview', async () => {
  const f = await setup();
  try {
    const photo = f.addPhoto(); f.photos.markDownloaded(photo.id);
    await f.capture.showPhoto(photo);
    const image = f.preview(), urls = [...f.activeUrls.keys()];
    f.el('#status').textContent = '写真を表示できませんでした。';
    f.el('#camera-message').textContent = 'カメラが見つかりません。接続を確認してください。';
    await f.change('#language', 'en');
    assert.equal(f.preview(), image);
    assert.deepEqual([...f.activeUrls.keys()], urls);
    assert.match(f.el('#status').textContent, /Could not display/);
    assert.match(f.el('#camera-message').textContent, /No camera/);
    assert.match(f.el('#gallery-list').children[0]['aria-label'], /downloaded/);
    assert.equal(JSON.parse(f.storage.get(savedKey)).language, 'en');
  } finally { await f.close(); }
});

test('pointer controls release focus while keyboard controls retain it, including help and full screen', async () => {
  const f = await setup();
  try {
    for (const selector of ['#camera-select', '#resolution', '#timer', '#language']) {
      const node = f.el(selector);
      node.listeners.get('pointerdown')(); await f.change(selector, node.value);
      assert.equal(node.blurred, true);
      node.blurred = false; node.listeners.get('pointerdown')(); node.listeners.get('keydown')();
      await f.change(selector, node.value); assert.equal(node.blurred, false);
    }
    const full = f.el('#fullscreen');
    full.listeners.get('click')({detail: 1}); await flush(); assert.equal(full.blurred, true);
    full.blurred = false; full.listeners.get('click')({detail: 0}); await flush(); assert.equal(full.blurred, false);
    const help = f.el('#shortcut-help'), button = f.el('#show-shortcuts');
    button.listeners.get('click')({detail: 1}); f.document.activeElement = button; help.close(); assert.equal(button.blurred, true);
    button.blurred = false; button.listeners.get('click')({detail: 0}); help.close(); assert.equal(button.blurred, false);
  } finally { await f.close(); }
});

test('invalid saved settings and denied camera access leave controls usable', async () => {
  for (const saved of ['invalid', JSON.stringify({timer: '100', resolution: 'bad', cameraId: 42}), 'null']) {
    const f = await setup({storage: new Map([[savedKey, saved]])});
    try {
      assert.equal(f.el('#timer').value, '0'); assert.equal(f.el('#resolution').value, '1080');
      f.mediaDevices.getUserMedia = async () => { throw new DOMException('', 'NotAllowedError'); };
      await f.camera.openCamera();
      assert.equal(f.camera.getState().busy, false);
      assert.equal(f.camera.getState().status, 'CONNECTION ERROR');
      assert.match(f.el('#camera-message').textContent, /許可/);
      await f.change('#timer', '3');
    } finally { await f.close(); }
  }
});

test('new photos appear in the gallery after the return animation and keep a stable count', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera();
    for (let count = 1; count <= 3; count++) {
      await f.capture.capturePhoto();
      assert.equal(f.capture.getState().capturePhase, 'returning');
      assert.equal(f.el('#photo-count').textContent, String(count));
      assert.equal(f.el('#gallery-list').children.length, count - 1);
      const departure = f.returning()[0];
      assert.notEqual(departure.children[0], f.preview());
      assert.equal(f.preview().src, departure.children[0].src);
      assert.equal(departure.animationCalls[0].options.duration, 2000);
      departure.animationCalls[0].finish(); await flush();
      assert.equal(f.capture.getState().capturePhase, 'live');
      assert.equal(f.el('#gallery-list').children.length, count);
      assert.equal(f.activeUrls.size, count);
    }
  } finally { await f.close(); }
});

test('gallery reserves space once per new photo, and reduced motion skips the reservation animation', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); f.addPhoto(); f.redraw();
    await f.capture.capturePhoto();
    const gallery = f.el('#gallery-list'), spacing = gallery.animationCalls.at(-1), count = gallery.animationCalls.length;
    assert.equal(spacing.options.duration, 300);
    f.redraw(); assert.equal(gallery.animationCalls.length, count);
    f.returning()[0].animationCalls[0].finish(); await flush(); assert.equal(spacing.cancelled, true);
    f.motion.matches = true; await f.capture.capturePhoto();
    assert.equal(gallery.animationCalls.length, count);
  } finally { await f.close(); }
});

test('Space dismisses the capture review while its animation continues, then allows a new capture', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.capture.capturePhoto();
    const departure = f.returning()[0], animation = departure.animationCalls[0];
    assert.equal(await f.press(' '), true);
    assert.equal(f.capture.getState().captureReturnInProgress, false);
    assert.equal(f.el('#photo-review').hidden, true);
    assert.equal(animation.cancelled, false);
    assert.equal(f.photos.list().length, 1);
    await f.press(' '); assert.equal(f.photos.list().length, 2);
    animation.finish(); await flush();
    assert.equal(f.capture.getState().captureReturnInProgress, true);
    assert.equal(f.el('#photo-review').hidden, false);
  } finally { await f.close(); }
});

test('switching photos retains the current preview until decoding succeeds and releases failed or stale loads', async () => {
  const f = await setup();
  try {
    const [first, second, third] = [f.addPhoto('first'), f.addPhoto('second'), f.addPhoto('third')];
    await f.capture.showPhoto(first); const firstImage = f.preview(), firstUrl = firstImage.src;
    const loads = [], create = f.document.createElement;
    f.document.createElement = tag => { const image = create(tag); if (tag === 'img') image.decode = () => { const load = deferred(); loads.push(load); return load.promise; }; return image; };
    const switching = f.capture.showPhoto(second);
    assert.equal(f.preview(), firstImage); assert.equal(f.capture.getState().selectedPhotoId, first.id);
    loads.shift().resolve(); assert.equal(await switching, true);
    assert.equal(f.capture.getState().selectedPhotoId, second.id); assert.equal(f.activeUrls.has(firstUrl), false);
    const secondImage = f.preview(); const failed = f.capture.showPhoto(third);
    loads.shift().reject(new Error('decode failed')); assert.equal(await failed, false);
    assert.equal(f.preview(), secondImage); assert.equal(f.capture.getState().capturePhase, 'review');
    const cancelled = f.capture.showPhoto(third); f.camera.stop(); loads.shift().resolve();
    assert.equal(await cancelled, false); assert.equal(f.capture.getState().selectedPhotoId, null);
    assert.equal(f.activeUrls.size, 3);
  } finally { await f.close(); }
});

for (const seconds of [3, 5, 10]) test(`${seconds}s countdown fires at the deadline exactly once`, async () => {
  const f = await setup({deferPng: true});
  try {
    await f.camera.openCamera(); await f.change('#timer', String(seconds));
    f.capture.startShooting(); assert.equal(f.el('#countdown').textContent, String(seconds));
    await f.advance(seconds * 1000 - 1); assert.equal(f.pending.length, 0); assert.equal(f.el('#countdown').textContent, '1');
    await f.advance(1); assert.equal(f.pending.length, 1); assert.equal(f.el('#countdown').hidden, true);
    f.capture.startShooting(); await f.advance(1000); assert.equal(f.pending.length, 1);
    f.pending[0].callback(new Blob(['png'])); await flush();
  } finally { await f.close(); }
});

for (const cancel of ['shutter', 'escape', 'visibility', 'disconnect']) test(`countdown cancels on ${cancel} without capturing`, async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.change('#timer', '3'); f.capture.startShooting();
    if (cancel === 'shutter') f.capture.startShooting();
    if (cancel === 'escape') await f.press('Escape');
    if (cancel === 'visibility') { f.document.hidden = true; f.document.listeners.get('visibilitychange')(); }
    if (cancel === 'disconnect') f.tracks[0].listeners.get('ended')();
    await f.advance(5000);
    assert.equal(f.photos.list().length, 0); assert.equal(f.el('#countdown').hidden, true);
    assert.equal(f.capture.getState().capturePhase, 'live');
  } finally { await f.close(); }
});

test('keyboard shortcuts navigate, download, return, and ignore repeats, composing input, modifiers, and form controls', async () => {
  const f = await setup({reducedMotion: true});
  try {
    await f.camera.openCamera();
    const [first, second, third] = [f.addPhoto(), f.addPhoto(), f.addPhoto()]; await f.capture.showPhoto(second);
    await f.press('ArrowLeft'); assert.equal(f.capture.getState().selectedPhotoId, first.id);
    await f.press('ArrowRight'); assert.equal(f.capture.getState().selectedPhotoId, second.id);
    await f.press('ArrowRight', {repeat: true}); assert.equal(f.capture.getState().selectedPhotoId, third.id);
    const selected = f.capture.getState().selectedPhotoId;
    for (const extra of [{repeat: true}, {isComposing: true}, {altKey: true}, {ctrlKey: true}, {target: f.el('#timer')}]) {
      assert.equal(await f.press('s', extra), false); assert.equal(f.photos.get(selected).downloadStarted, undefined);
    }
    await f.press('s'); assert.equal(f.photos.get(selected).downloadStarted, true);
    await f.press('f'); assert.equal(f.document.fullscreenElement, f.el('#viewfinder'));
    await f.press('Escape'); assert.equal(f.capture.getState().selectedPhotoId, selected);
    await f.press('f'); await f.press('Escape'); assert.equal(f.capture.getState().selectedPhotoId, null);
    await f.press('ArrowRight'); assert.equal(f.capture.getState().selectedPhotoId, first.id);
    await f.press(' '); assert.equal(f.capture.getState().capturePhase, 'live');
    await f.press('ArrowLeft'); assert.equal(f.capture.getState().selectedPhotoId, third.id);
  } finally { await f.close(); }
});

test('vertical arrows restore the last viewed photo and fall back to the latest when it is deleted', async () => {
  const f = await setup({reducedMotion: true});
  try {
    const [first, second, third] = [f.addPhoto(), f.addPhoto(), f.addPhoto()];
    await f.press('ArrowDown'); assert.equal(f.capture.getState().selectedPhotoId, third.id);
    await f.press('ArrowUp'); assert.equal(f.capture.getState().selectedPhotoId, null);
    await f.capture.showPhoto(second); await f.capture.returnToCamera();
    await f.press('ArrowDown'); assert.equal(f.capture.getState().selectedPhotoId, second.id);
    await f.press('ArrowUp'); f.photos.remove(second.id);
    await f.press('ArrowDown'); assert.equal(f.capture.getState().selectedPhotoId, third.id);
    assert.equal(await f.press('ArrowUp', {target: f.el('#timer')}), false);
    assert.equal(f.capture.getState().selectedPhotoId, third.id);
    assert(f.photos.get(first.id));
  } finally { await f.close(); }
});

test('Space preserves native activation of buttons and links during review and capture return', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.capture.showPhoto(f.addPhoto());
    for (const target of [f.document.createElement('button'), f.document.createElement('a')]) {
      assert.equal(await f.press(' ', {target}), false); assert.equal(f.capture.getState().capturePhase, 'review');
    }
    const closing = f.capture.returnToCamera();
    f.returning()[0].animationCalls[0].finish(); await closing;
    await f.capture.capturePhoto();
    for (const target of [f.document.createElement('button'), f.document.createElement('a')]) {
      assert.equal(await f.press(' ', {target}), false); assert.equal(f.capture.getState().captureReturnInProgress, true);
    }
  } finally { await f.close(); }
});

test('Enter starts an idle camera and the help dialog blocks camera and photo shortcuts', async () => {
  const f = await setup();
  try {
    assert.equal(await f.press('Delete'), false);
    await f.press('Enter'); assert.equal(f.requests.length, 1);
    await f.press('Enter'); assert.equal(f.requests.length, 1);
    await f.capture.showPhoto(f.addPhoto());
    await f.press('?'); assert.equal(f.el('#shortcut-help').open, true);
    await f.press('Delete'); await f.press(' '); await f.press('Enter');
    assert.equal(f.photos.list().length, 1); assert.equal(f.capture.getState().capturePhase, 'review');
    await f.press('Escape'); assert.equal(f.el('#shortcut-help').open, false);
    await f.press('Backspace'); assert.equal(f.photos.list().length, 0);
    await f.capture.undoDelete(); await f.press('Delete'); assert.equal(f.photos.list().length, 0);
  } finally { await f.close(); }
});

test('deletion selects the newer neighbor, then the older neighbor, then returns to the camera', async () => {
  const f = await setup();
  try {
    const [first, second, third] = [f.addPhoto(), f.addPhoto(), f.addPhoto()]; await f.capture.showPhoto(second);
    await f.capture.deleteSelectedPhoto(); assert.equal(f.capture.getState().selectedPhotoId, third.id);
    await f.capture.deleteSelectedPhoto(); assert.equal(f.capture.getState().selectedPhotoId, first.id);
    await f.capture.deleteSelectedPhoto(); assert.equal(f.capture.getState().selectedPhotoId, null);
    assert.equal(f.capture.getState().capturePhase, 'live'); assert.equal(f.el('#photo-count').textContent, '0');
  } finally { await f.close(); }
});

test('deletion preserves the image, gallery and position until the next photo is decoded', async () => {
  const f = await setup();
  try {
    const [first, second] = [f.addPhoto(), f.addPhoto()]; f.addPhoto(); await f.capture.showPhoto(second);
    const image = f.preview(), buttons = f.el('#gallery-list').children;
    const create = f.document.createElement, decode = deferred();
    f.document.createElement = tag => { const image = create(tag); if (tag === 'img') image.decode = () => decode.promise; return image; };
    const deleting = f.capture.deleteSelectedPhoto();
    assert.equal(f.preview(), image); assert.equal(f.el('#gallery-list').children, buttons);
    assert.equal(f.el('#photo-position').textContent, '2 / 3');
    decode.resolve(); await deleting;
    assert.equal(f.el('#photo-position').textContent, '2 / 2');
    assert(f.photos.get(first.id));
  } finally { await f.close(); }
});

for (const modifiers of [{}, {metaKey: true}, {ctrlKey: true}]) test(`keyboard undo ${JSON.stringify(modifiers)} restores selection and scrolls it into view`, async () => {
  const f = await setup();
  try {
    f.addPhoto(); const second = f.addPhoto(); f.addPhoto(); await f.capture.showPhoto(second); await f.capture.deleteSelectedPhoto();
    for (const extra of [{repeat: true}, {shiftKey: true}, {altKey: true}, {target: f.el('#timer')}]) {
      await f.press('z', {...modifiers, ...extra}); assert.equal(f.photos.get(second.id), undefined);
    }
    await f.press('z', modifiers);
    assert.equal(f.capture.getState().selectedPhotoId, second.id); assert.equal(f.photos.canUndo, false);
    const selected = f.el('#gallery-list').children.find(button => button['aria-pressed'] === 'true');
    assert.equal(selected.dataset.photoId, String(second.id)); assert.equal(selected.scrollOptions.inline, 'nearest');
  } finally { await f.close(); }
});

test('photo position numbers run from oldest to newest and disappear when review closes', async () => {
  const f = await setup({reducedMotion: true});
  try {
    const first = f.addPhoto(); f.addPhoto(); const third = f.addPhoto();
    await f.capture.showPhoto(first); assert.equal(f.el('#photo-position').textContent, '1 / 3');
    await f.capture.showPhoto(third); assert.equal(f.el('#photo-position').textContent, '3 / 3');
    await f.capture.returnToCamera(); assert.equal(f.el('#photo-position').hidden, true);
    assert.equal(f.el('#photo-count').hidden, false); assert.equal(f.el('#photo-count').textContent, '3');
  } finally { await f.close(); }
});

test('unsaved warnings track downloads, deletion and undo without losing photos on cancelled navigation', async () => {
  const f = await setup();
  try {
    const first = f.addPhoto(), second = f.addPhoto(); await f.capture.showPhoto(first);
    let prevented = false;
    f.window.listeners.get('beforeunload')({preventDefault() { prevented = true; }});
    assert.equal(prevented, true); assert.equal(f.photos.list().length, 2);
    f.capture.downloadSelectedPhoto(); assert.equal(f.photos.get(first.id).downloadStarted, true);
    assert.equal(f.window.listeners.has('beforeunload'), true);
    await f.capture.showPhoto(second); await f.capture.deleteSelectedPhoto();
    assert.equal(f.window.listeners.has('beforeunload'), false);
    await f.capture.undoDelete(); assert.equal(f.window.listeners.has('beforeunload'), true);
    f.capture.downloadSelectedPhoto(); assert.equal(f.window.listeners.has('beforeunload'), false);
    await f.capture.deleteSelectedPhoto(); await f.capture.undoDelete();
    assert.equal(f.window.listeners.has('beforeunload'), false);
  } finally { await f.close(); }
});

test('100 captures and deletions release preview, canvas and download resources while retaining undo thumbnails', async () => {
  const f = await setup({reducedMotion: true});
  try {
    await f.camera.openCamera();
    for (let count = 1; count <= 100; count++) {
      await f.capture.capturePhoto(); assert.equal(f.photos.list().length, count); assert.equal(f.activeUrls.size, count);
      assert.equal(f.el('#gallery-list').children.length, count);
      assert.equal(f.photos.list()[0].width, 1920); assert.equal(f.photos.list()[0].height, 1080);
    }
    for (const canvas of f.encodings) { assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); }
    for (let remaining = 100; remaining > 0; remaining--) {
      await f.capture.showPhoto(f.photos.list()[0]); f.capture.downloadSelectedPhoto(); await f.capture.deleteSelectedPhoto();
      assert.equal(f.photos.list().length, remaining - 1);
      assert.equal(f.activeUrls.size, remaining > 1 ? 101 : 100);
      assert.equal(f.el('#gallery-list').children.length, remaining - 1);
    }
  } finally { await f.close(); }
});

test('deletion and restoration animate for 300ms, reuse thumbnail elements, and cancel on reset', async () => {
  const f = await setup();
  try {
    const first = f.addPhoto(), second = f.addPhoto(); f.addPhoto(); await f.capture.showPhoto(second);
    const gallery = f.el('#gallery-list'), older = gallery.children.find(button => button.dataset.photoId === String(first.id));
    await f.capture.deleteSelectedPhoto();
    assert.equal(gallery.children.find(button => button.dataset.photoId === String(first.id)), older);
    assert.equal(older.animationCalls.at(-1).options.duration, 300);
    const departing = f.el('.gallery').children[0];
    assert.equal(departing['aria-hidden'], 'true'); assert.equal(departing.animationCalls[0].options.duration, 300);
    departing.animationCalls[0].finish(); await flush(); assert.equal(f.el('.gallery').children.length, 0);
    await f.capture.undoDelete(); const restored = gallery.children.find(button => button.dataset.photoId === String(second.id));
    assert.equal(restored.animationCalls[0].frames[0].opacity, 0);
    const count = restored.animationCalls.length; f.redraw(); assert.equal(restored.animationCalls.length, count);
    const current = f.animations.filter(animation => animation.options.duration === 300 && !animation.settled);
    f.camera.stop(); await flush(); assert(current.every(animation => animation.cancelled));
    f.motion.matches = true; await f.capture.showPhoto(second); const before = f.animations.length;
    await f.capture.deleteSelectedPhoto(); await f.capture.undoDelete(); assert.equal(f.animations.length, before);
  } finally { await f.close(); }
});

test('multiple deletions restore in reverse order with their download state preserved', async () => {
  const f = await setup();
  try {
    const first = f.addPhoto(), second = f.addPhoto(), third = f.addPhoto(); f.photos.markDownloaded(second.id);
    await f.capture.showPhoto(second);
    for (let i = 0; i < 3; i++) await f.capture.deleteSelectedPhoto();
    for (const id of [first.id, third.id, second.id]) { await f.capture.undoDelete(); assert.equal(f.capture.getState().selectedPhotoId, id); }
    assert.deepEqual(ids(f), [third.id, second.id, first.id]); assert.equal(f.photos.get(second.id).downloadStarted, true);
  } finally { await f.close(); }
});

test('cancelled and failed captures preserve undo history, while successful capture discards it', async () => {
  const f = await setup({deferPng: true, reducedMotion: true});
  try {
    await f.camera.openCamera(); const first = f.addPhoto(), second = f.addPhoto();
    f.photos.removeUndoable(first.id); f.photos.removeUndoable(second.id);
    await f.change('#timer', '3'); f.capture.startShooting(); f.capture.cancelCountdown(); assert.equal(f.photos.canUndo, true);
    const failed = f.capture.capturePhoto(); f.pending[0].callback(null); await failed; assert.equal(f.photos.canUndo, true);
    const create = f.document.createElement;
    f.document.createElement = tag => { const image = create(tag); if (tag === 'img') image.decode = async () => { throw new Error('decode failed'); }; return image; };
    const failedPreview = f.capture.capturePhoto(); f.pending[1].callback(new Blob(['png'])); await failedPreview;
    assert.equal(f.photos.canUndo, true); assert.equal(f.activeUrls.size, 2);
    f.document.createElement = create;
    const success = f.capture.capturePhoto(); f.pending[2].callback(new Blob(['png'])); await success;
    assert.equal(f.photos.canUndo, false); assert.equal(f.activeUrls.size, 1);
  } finally { await f.close(); }
});

test('old return animation completion preserves a new capture and preview', async () => {
  const f = await setup({deferPng: true});
  try {
    await f.camera.openCamera(); await f.capture.showPhoto(f.addPhoto());
    const returning = f.capture.returnToCamera(), oldAnimation = f.returning()[0].animationCalls[0];
    assert.equal(f.capture.getActions().canShoot, true);
    const capturing = f.capture.capturePhoto(); f.pending[0].callback(new Blob(['new'])); await capturing;
    assert.equal(f.returning().length, 2); assert.equal(oldAnimation.cancelled, false);
    oldAnimation.finish(); await returning;
    assert.equal(f.returning().length, 1); assert.equal(f.capture.getState().captureReturnInProgress, true);
    assert.equal(f.el('#photo-review').hidden, false); assert.equal(f.activeUrls.size, 3);
    f.returning()[0].animationCalls[0].finish(); await flush(); assert.equal(f.activeUrls.size, 2);
  } finally { await f.close(); }
});

test('closing review deselects immediately and allows reopening before the old animation finishes', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); const photo = f.addPhoto(); await f.capture.showPhoto(photo);
    const returning = f.capture.returnToCamera(), animation = f.returning()[0].animationCalls[0];
    assert.equal(f.capture.getState().selectedPhotoId, null); assert.equal(f.el('#gallery-list').children[0]['aria-pressed'], 'false');
    assert.equal(f.el('#gallery-list').children[0].disabled, false);
    f.el('#gallery-list').children[0].click(); await flush();
    assert.equal(f.capture.getState().selectedPhotoId, photo.id);
    animation.finish(); await returning; assert.equal(f.capture.getState().selectedPhotoId, photo.id);
    assert.equal(f.el('#photo-review').hidden, false);
  } finally { await f.close(); }
});

test('overlapping return animations keep the older image in front and release their resources independently', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.capture.showPhoto(f.addPhoto());
    const firstReturn = f.capture.returnToCamera(), first = f.returning()[0];
    await f.capture.showPhoto(f.addPhoto()); const secondReturn = f.capture.returnToCamera(), second = f.returning()[1];
    assert(Number(first.style.zIndex) > Number(second.style.zIndex));
    first.animationCalls[0].finish(); await firstReturn;
    assert.equal(f.returning().length, 1); assert.equal(f.capture.getState().capturePhase, 'returning');
    second.animationCalls[0].finish(); await secondReturn;
    assert.equal(f.returning().length, 0); assert.equal(f.capture.getState().capturePhase, 'live'); assert.equal(f.activeUrls.size, 2);
  } finally { await f.close(); }
});

test('a stale capture after disconnect cannot change the new canvas or append its photo', async () => {
  const f = await setup({deferPng: true});
  try {
    await f.camera.openCamera(); const first = f.capture.capturePhoto(); f.camera.stop();
    await f.camera.openCamera(); const second = f.capture.capturePhoto();
    f.pending[0].callback(new Blob(['old'])); await first;
    assert.equal(f.pending[1].canvas.width, 1920); assert.equal(f.pending[1].canvas.height, 1080);
    f.pending[1].callback(new Blob(['new'])); await second;
    assert.equal(f.photos.list().length, 1); assert.equal(await f.photos.list()[0].original.text(), 'new');
  } finally { await f.close(); }
});

test('rendering cannot apply pending camera settings, and DOM disabled flags do not govern capture operations', async () => {
  const f = await setup({deferPng: true});
  try {
    await f.camera.openCamera(); f.el('#shutter').disabled = true;
    const taking = f.capture.capturePhoto(); assert.equal(f.pending.length, 1);
    await f.camera.selectCamera('usb');
    f.view.renderControls(f.camera.getState(), f.capture.getState(), f.capture.getActions(), f.photos.canUndo);
    await flush(); assert.equal(f.requests.length, 1);
    f.pending[0].callback(new Blob(['png'])); await taking;
    const before = f.photos.list().length; f.el('#shutter').disabled = false;
    await f.capture.capturePhoto(); assert.equal(f.photos.list().length, before); assert.equal(f.pending.length, 1);
    f.returning()[0].animationCalls[0].finish(); await flush(); assert.equal(f.camera.getState().preferredCameraId, 'usb');
  } finally { await f.close(); }
});

test('stale camera connections stop their stream and cannot replace a newer connection', async () => {
  const f = await setup();
  try {
    const pending = deferred(), create = f.mediaDevices.getUserMedia;
    f.mediaDevices.getUserMedia = () => pending.promise;
    const first = f.camera.openCamera(); f.camera.stop();
    f.mediaDevices.getUserMedia = create; await f.camera.openCamera();
    const current = f.camera.getState().stream, stale = f.makeStream('usb');
    pending.resolve(stale); await first;
    assert.equal(stale.getTracks()[0].stopped, true); assert.equal(f.camera.getState().stream, current);
    assert.equal(f.el('#camera').srcObject, current);
  } finally { await f.close(); }
});

test('animation timeout releases the preview when the browser does not finish its timeline', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.capture.capturePhoto();
    await f.advance(2120); assert.equal(f.returning().length, 0);
    assert.equal(f.capture.getState().capturePhase, 'live'); assert.equal(f.activeUrls.size, 1);
  } finally { await f.close(); }
});

test('persisted pagehide stops the camera while retaining photos, and download URLs expire', async () => {
  const f = await setup();
  try {
    await f.camera.openCamera(); await f.capture.showPhoto(f.addPhoto()); f.capture.downloadSelectedPhoto();
    assert.equal(f.activeUrls.size, 3); await f.advance(60000); assert.equal(f.activeUrls.size, 2);
    f.window.listeners.get('pagehide')({persisted: true}); await flush();
    assert.equal(f.camera.getState().stream, null); assert.equal(f.photos.list().length, 1);
    assert.equal(f.activeUrls.size, 1);
  } finally { await f.close(); }
});
