import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup({ deferPng = false, storage = new Map(), storageBlocked = false, browserLanguage = 'ja-JP' } = {}) {
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
      listeners: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      replaceChildren(...children) { this.children = children; },
      cloneNode() { return Object.assign(element(), { src: this.src, alt: this.alt, id: this.id }); },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      remove() {},
      click() {},
      scrollIntoView(options) { this.scrollOptions = options; },
      showModal() { this.open = true; },
      close() { this.open = false; },
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
        assert([180, 300, 2000].includes(options.duration));
        return { finished: new Promise(resolve => { finishAnimation = resolve; }), cancelled: false, cancel() { this.cancelled = true; } };
      },
    };
  }
  const document = {
    body: element(),
    documentElement: {},
    querySelectorAll: () => [],
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
    document, navigator: { language: browserLanguage },
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('storage blocked'); storage.set(key, value); },
    },
    window: {
      listeners: new Map(), matchMedia: () => ({ matches: false }),
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      removeEventListener(name) { this.listeners.delete(name); },
    },
    ResizeObserver: class { observe() {} },
    URL: {
      createObjectURL(blob) { const url = `blob:${++nextUrl}`; activeUrls.set(url, blob); return url; },
      revokeObjectURL(url) { activeUrls.delete(url); },
    },
    Date, Blob, setTimeout, clearTimeout, DOMException,
  });
  for (const file of ['photo-store.ts', 'return-effects.ts', 'i18n.ts', 'settings.ts', 'main.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    vm.runInContext(compiled, context);
  }
  const run = source => vm.runInContext(source, context);
  return { elements, context, run, finish: () => finishAnimation(), completion: () => finishAnimation, document, activeUrls, encodings, pending };
}

test('camera selection lists video inputs, switches devices, and keeps the original stream on failure', async () => {
  const storage = new Map();
  const { run, context, elements } = setup({storage});
  const tracks = [];
  const requests = [];
  const makeStream = id => {
    const track = {
      stopped: false, stop() { this.stopped = true; }, addEventListener() {},
      getSettings: () => ({ deviceId: id, width: 1920, height: 1080, frameRate: 30 }),
    };
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  context.navigator.mediaDevices = {
    enumerateDevices: async () => [
      {kind: 'videoinput', deviceId: 'built-in', label: '内蔵カメラ'},
      {kind: 'audioinput', deviceId: 'mic', label: 'マイク'},
      {kind: 'videoinput', deviceId: 'usb', label: 'USBカメラ'},
    ],
    getUserMedia: async options => {
      requests.push(options);
      if (options.video.deviceId?.exact === 'unavailable') throw new DOMException('not available', 'NotReadableError');
      return makeStream(options.video.deviceId?.exact || 'built-in');
    },
  };
  elements.get('#camera').play = async () => {};
  try {
    await run('updateCameraList()');
    const selector = elements.get('#camera-select');
    assert.deepEqual(selector.children.map(option => option.value), ['', 'built-in', 'usb']);
    await run('openCamera()');
    assert.equal(selector.value, 'built-in');
    assert.equal(selector.disabled, false);
    selector.value = 'usb';
    await selector.listeners.get('change')();
    assert.equal(requests[1].video.deviceId.exact, 'usb');
    assert.equal(requests[1].audio, false);
    assert.equal(tracks[0].stopped, true);
    assert.equal(tracks[1].stopped, false);
    assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).cameraId, 'usb');
    const active = run('stream');
    selector.value = 'unavailable';
    await selector.listeners.get('change')();
    assert.equal(run('stream'), active);
    assert.equal(selector.value, 'usb');
    assert.equal(tracks[1].stopped, false);
    assert.equal(elements.get('#camera').srcObject, active);
    assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).cameraId, 'usb');
    run("capturePhase = 'review'; setBusy(false);");
    assert.equal(selector.disabled, false);
  } finally {
    run('resetCamera();');
  }
});

test('camera changes during capture are deferred until the gallery animation finishes and use the latest choice', async () => {
  const { run, context, elements, pending, finish } = setup({deferPng: true});
  const requests = [];
  const tracks = [];
  context.navigator.mediaDevices = {
    enumerateDevices: async () => ['built-in', 'usb', 'external'].map(id => ({kind: 'videoinput', deviceId: id, label: id})),
    getUserMedia: async options => {
      const id = options.video.deviceId?.exact || 'built-in';
      requests.push(id);
      const track = {stop() {}, addEventListener() {}, getSettings: () => ({deviceId: id, width: 1920, height: 1080})};
      tracks.push(track);
      return {getTracks: () => [track], getVideoTracks: () => [track]};
    },
  };
  elements.get('#camera').play = async () => {};
  try {
    await run('updateCameraList();');
    await run('openCamera()');
    const capturing = run('capturePhoto()');
    const selector = elements.get('#camera-select');
    assert.equal(selector.disabled, false);
    selector.value = 'usb';
    await selector.listeners.get('change')();
    selector.value = 'external';
    await selector.listeners.get('change')();
    assert.deepEqual(requests, ['built-in']);
    pending[0].callback(new Blob(['png'], {type: 'image/png'}));
    await capturing;
    assert.equal(run('capturePhase'), 'returning');
    assert.equal(elements.get('#live-badge').children[1], ' PHOTO');
    assert.deepEqual(requests, ['built-in']);
    finish();
    for (let i = 0; i < 12; i++) await run('Promise.resolve()');
    assert.deepEqual(requests, ['built-in', 'external']);
    assert.equal(selector.value, 'external');
    assert.equal(elements.get('#photo-review').hidden, true);
    assert.equal(run('capturePhase'), 'live');
    assert.equal(elements.get('#live-badge').children[1], ' LIVE');
  } finally {
    run('resetCamera(); photos.clear();');
  }
});

test('saved camera selection is restored, survives hidden devices before permission, and resets when unavailable', async () => {
  const storage = new Map([['photo-booth.settings.v1', JSON.stringify({timer: '0', resolution: '1080', cameraId: 'usb'})]]);
  const { run, context, elements } = setup({storage});
  context.navigator.mediaDevices = { enumerateDevices: async () => [] };
  await run('updateCameraList()');
  assert.equal(run('preferredCameraId'), 'usb');
  context.navigator.mediaDevices.enumerateDevices = async () => [{kind: 'videoinput', deviceId: 'usb', label: 'USBカメラ'}];
  await run('updateCameraList()');
  assert.equal(elements.get('#camera-select').value, 'usb');
  elements.get('#camera-select').value = '';
  await elements.get('#camera-select').listeners.get('change')();
  assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).cameraId, '');
  elements.get('#camera-select').value = 'usb';
  await elements.get('#camera-select').listeners.get('change')();
  const reloaded = setup({storage});
  assert.equal(reloaded.run('preferredCameraId'), 'usb');
  reloaded.context.navigator.mediaDevices = { enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'built-in', label: '内蔵カメラ'}] };
  await reloaded.run('updateCameraList()');
  assert.equal(reloaded.elements.get('#camera-select').value, '');
  assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).cameraId, '');
});

test('starting with a missing saved camera falls back to automatic and remembers the camera actually used', async () => {
  const storage = new Map([['photo-booth.settings.v1', JSON.stringify({timer: '0', resolution: '1080', cameraId: 'missing'})]]);
  const { run, context, elements } = setup({storage});
  const requests = [];
  const track = { stop() {}, addEventListener() {}, getSettings: () => ({deviceId: 'built-in', width: 1920, height: 1080}) };
  context.navigator.mediaDevices = {
    getUserMedia: async options => {
      requests.push(options);
      if (options.video.deviceId) throw new DOMException('camera removed', 'NotFoundError');
      return {getTracks: () => [track], getVideoTracks: () => [track]};
    },
    enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'built-in', label: '内蔵カメラ'}],
  };
  elements.get('#camera').play = async () => {};
  try {
    await run('openCamera()');
    assert.equal(requests[0].video.deviceId.exact, 'missing');
    assert.equal(requests[1].video.deviceId, undefined);
    assert.equal(elements.get('#camera-select').value, 'built-in');
    assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).cameraId, 'built-in');
  } finally {
    run('resetCamera()');
  }
});

test('timer and successfully applied resolution settings persist across reloads, including resolution rollback', async () => {
  const storage = new Map([['photo-booth.settings.v1', JSON.stringify({timer: '5', resolution: '720'})]]);
  const { run, elements } = setup({storage});
  assert.equal(elements.get('#timer').value, '5');
  assert.equal(elements.get('#resolution').value, '720');
  assert.equal(run('appliedResolution'), '720');
  elements.get('#timer').value = '10';
  elements.get('#timer').listeners.get('change')();
  run(`stream = { getVideoTracks: () => [{
    getConstraints: () => ({}), getSettings: () => ({}),
    applyConstraints: async value => { if (value.height?.exact === 2160) throw new Error('unsupported'); }
  }] };`);
  elements.get('#resolution').value = '1080';
  await elements.get('#resolution').listeners.get('change')();
  assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).resolution, '1080');
  elements.get('#resolution').value = '2160';
  await elements.get('#resolution').listeners.get('change')();
  assert.equal(elements.get('#resolution').value, '1080');
  assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).resolution, '1080');
  const reloaded = setup({storage});
  assert.equal(reloaded.elements.get('#timer').value, '10');
  assert.equal(reloaded.elements.get('#resolution').value, '1080');
});

test('resolution and timer remain enabled before starting and during review, and rapid resolution changes apply the latest choice', async () => {
  const storage = new Map();
  const { run, context, elements } = setup({storage});
  const selector = elements.get('#resolution');
  run('setBusy(false);');
  assert.equal(selector.disabled, false);
  assert.equal(elements.get('#timer').disabled, false);
  selector.value = '720';
  await selector.listeners.get('change')();
  assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).resolution, '720');
  const applied = [];
  let finishFirst;
  context.testTrack = {
    getConstraints: () => ({}), getSettings: () => ({}),
    applyConstraints: options => {
      applied.push(options.height.exact);
      return applied.length === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve();
    },
  };
  run(`stream = {getTracks: () => [], getVideoTracks: () => [testTrack]};
    photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
  try {
    await run('showPhoto(photos.get(1))');
    const image = run('capturedPhoto');
    const firstChange = selector.listeners.get('change')();
    assert.equal(selector.disabled, false);
    assert.equal(elements.get('#timer').disabled, false);
    selector.value = '2160';
    await selector.listeners.get('change')();
    finishFirst();
    await firstChange;
    await run('Promise.resolve()');
    await run('Promise.resolve()');
    assert.deepEqual(applied, [720, 2160]);
    assert.equal(selector.value, '2160');
    assert.equal(run('appliedResolution'), '2160');
    assert.equal(run('capturedPhoto'), image);
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(JSON.parse(storage.get('photo-booth.settings.v1')).resolution, '2160');
  } finally {
    run('resetCamera(); photos.clear();');
  }
});

test('language defaults to the browser, respects saved choices, and tolerates invalid or blocked storage', () => {
  for (const browserLanguage of ['en-US', 'fr-FR', 'ja-JP']) {
    const { run, document, elements } = setup({browserLanguage});
    const expected = browserLanguage.startsWith('ja') ? 'ja' : 'en';
    assert.equal(run('getLanguage()'), expected);
    assert.equal(document.documentElement.lang, expected);
    assert.equal(elements.get('#language').value, expected);
  }
  const storage = new Map([['photo-booth.settings.v1', JSON.stringify({language: 'ja'})]]);
  assert.equal(setup({browserLanguage: 'en-US', storage}).run('getLanguage()'), 'ja');
  storage.set('photo-booth.settings.v1', JSON.stringify({language: 'invalid'}));
  assert.equal(setup({browserLanguage: 'en-US', storage}).run('getLanguage()'), 'en');
  assert.equal(setup({browserLanguage: 'en-US', storageBlocked: true}).run('getLanguage()'), 'en');
});

test('switching languages updates photo metadata and errors without interrupting the preview and persists on reload', async () => {
  const storage = new Map();
  const { run, elements, activeUrls } = setup({storage});
  try {
    run('photos.add(new Blob(["png"]), new Blob(["jpg"]), 1920, 1080); photos.markDownloaded(1);');
    await run('showPhoto(photos.get(1))');
    run("status.textContent = errorMessage(new DOMException('', 'NotFoundError')); message.textContent = errorMessage(new DOMException('', 'NotAllowedError')); startButton.textContent = t('カメラを開始');");
    const originalUrls = [...activeUrls.keys()];
    elements.get('#language').value = 'en';
    elements.get('#language').listeners.get('change')();
    assert.equal(run('capturePhase'), 'review');
    assert.equal(run('selectedPhotoId'), 1);
    assert.deepEqual([...activeUrls.keys()], originalUrls);
    assert.equal(elements.get('#gallery-list').children[0]['aria-label'], 'View photo 1 (downloaded)');
    assert.equal(elements.get('#photo-position')['aria-label'], 'Photo 1 of 1');
    assert.equal(elements.get('#status').textContent, 'No camera found. Check the connection.');
    assert.equal(elements.get('#camera-message').textContent, 'Allow camera access in your browser’s site settings.');
    assert.equal(elements.get('#start-camera').textContent, 'Start camera');
    assert.equal(setup({storage, browserLanguage: 'ja-JP'}).run('getLanguage()'), 'en');
    elements.get('#language').value = 'ja';
    elements.get('#language').listeners.get('change')();
    assert.equal(elements.get('#status').textContent, 'カメラが見つかりません。接続を確認してください。');
    assert.equal(elements.get('#gallery-list').children[0]['aria-label'], '写真 1 を表示（ダウンロード済み）');
  } finally {
    run('resetCamera(); photos.clear();');
  }
});

test('pointer operations release control focus while keyboard operations retain it', async () => {
  const { elements, document } = setup();
  for (const selector of ['#camera-select', '#resolution', '#timer']) {
    const control = elements.get(selector);
    let blurs = 0;
    control.blur = () => { blurs++; };
    control.listeners.get('pointerdown')();
    await control.listeners.get('change')();
    assert.equal(blurs, 1);
    control.listeners.get('pointerdown')();
    control.listeners.get('keydown')();
    await control.listeners.get('change')();
    assert.equal(blurs, 1);
  }
  const fullscreen = elements.get('#fullscreen');
  let fullscreenBlurs = 0;
  fullscreen.blur = () => { fullscreenBlurs++; };
  fullscreen.listeners.get('click')({detail: 1});
  fullscreen.listeners.get('click')({detail: 0});
  assert.equal(fullscreenBlurs, 1);

  const help = elements.get('#shortcut-help');
  const button = elements.get('#show-shortcuts');
  let helpBlurs = 0;
  button.blur = () => { helpBlurs++; };
  button.listeners.get('click')({detail: 1});
  assert.equal(helpBlurs, 0);
  document.activeElement = button;
  help.close();
  help.listeners.get('close')();
  assert.equal(helpBlurs, 1);
  button.listeners.get('click')({detail: 0});
  help.close();
  help.listeners.get('close')();
  assert.equal(helpBlurs, 1);
});

test('invalid or unavailable saved settings do not prevent camera initialization or control changes', () => {
  for (const value of ['broken json', 'null', JSON.stringify({timer: '999', resolution: '8K'})]) {
    const { run, elements } = setup({storage: new Map([['photo-booth.settings.v1', value]])});
    // The mock uses 1080 for every initial value; invalid stored values leave the DOM defaults intact.
    assert.equal(elements.get('#timer').value, '1080');
    assert.equal(elements.get('#resolution').value, '1080');
    assert.equal(run('appliedResolution'), '1080');
  }
  const { elements } = setup({storageBlocked: true});
  elements.get('#timer').value = '3';
  assert.doesNotThrow(() => elements.get('#timer').listeners.get('change')());
  assert.equal(elements.get('#timer').value, '3');
});

test('append each thumbnail after the return animation finishes while keeping the total count stable', async () => {
  const { elements, run, finish } = setup();
  try {
    for (let count = 1; count <= 2; count++) {
      run('photos.add(new Blob(["png"], {type:"image/png"}), new Blob(["jpg"], {type:"image/jpeg"}), 1920, 1080);');
      await run(`showPhoto(photos.get(${count}), true)`);
      const preparedImage = run(`thumbnailImages.get(${count})`);
      assert.equal(preparedImage.decoded, true);
      assert.equal(elements.get('#photo-count').textContent, String(count));
      assert.equal(elements.get('#gallery-list').children.length, count - 1);
      assert.equal(run('capturePhase'), 'returning');
      assert.equal(run('captureReturnInProgress'), true);
      assert.equal(elements.get('#photo-review').hidden, false);
      const preview = run('capturedPhoto');
      const departingImage = run('[...returningPhotos.keys()][0].children[0]');
      assert.notEqual(preview, departingImage);
      assert.equal(preview.src, departingImage.src);
      assert.equal(elements.get('#shutter').disabled, true);
      assert.equal(elements.get('#live-badge').children[1], ' PHOTO');
      assert.equal(elements.get('#photo-count').textContent, String(count));
      assert.equal(elements.get('#gallery-list').children.length, count - 1);
      finish();
      for (let i = 0; i < 4; i++) await run('Promise.resolve()');
      assert.equal(run('capturePhase'), 'live');
      assert.equal(run('captureReturnInProgress'), false);
      assert.equal(elements.get('#photo-review').hidden, true);
      assert.equal(preview.src, undefined);
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


test('Space returns to the camera during capture animation without stopping it or taking another photo', async () => {
  const { run, elements, document, finish, activeUrls } = setup();
  run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({width: 1920, height: 1080, frameRate: 30})}]};
    var shots = 0; startShooting = () => shots++;
    photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
  try {
    await run('showPhoto(photos.get(1), true)');
    const animation = run('[...returningPhotos.values()][0].animation');
    let prevented = false;
    const pressSpace = () => document.listeners.get('keydown')({key: ' ', target: null, preventDefault() { prevented = true; }});
    pressSpace();
    assert.equal(prevented, true);
    assert.equal(run('shots'), 0);
    assert.equal(run('captureReturnInProgress'), false);
    assert.equal(elements.get('#photo-review').hidden, true);
    assert.equal(elements.get('#shutter').disabled, false);
    assert.equal(elements.get('#live-badge').children[1], ' LIVE');
    assert.equal(elements.get('#actual-settings').textContent, '1920 × 1080 / 30 fps');
    assert.equal(animation.cancelled, false);
    assert.equal(run('returningPhotos.size'), 1);
    assert.equal(activeUrls.size, 2);
    assert.equal(elements.get('#gallery-list').children.length, 0);
    pressSpace();
    assert.equal(run('shots'), 1);
    finish();
    for (let i = 0; i < 4; i++) await run('Promise.resolve()');
    assert.equal(run('capturePhase'), 'live');
    assert.equal(run('returningPhotos.size'), 0);
    assert.equal(elements.get('#gallery-list').children.length, 1);
    assert.equal(activeUrls.size, 1);
  } finally {
    run('resetCamera(); photos.clear();');
  }
});

test('photo switching retains the current image until decoding succeeds and cleans up failed or cancelled loads', async () => {
  const { run, elements, activeUrls } = setup();
  try {
    run(`for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(1))');
    const firstImage = run('capturedPhoto');
    const firstUrl = run('photoUrl');
    run(`var imageLoads = [];
      var createElement = document.createElement;
      document.createElement = tag => {
        const image = createElement(tag);
        if (tag === 'img') image.decode = function () {
          if (this.id !== 'captured-photo') return Promise.resolve();
          return new Promise((resolve, reject) => imageLoads.push({resolve, reject}));
        };
        return image;
      };`);
    const switching = run('showPhoto(photos.get(2))');
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(run('capturedPhoto'), firstImage);
    assert.equal(run('selectedPhotoId'), 1);
    assert.equal(activeUrls.has(firstUrl), true);
    run('imageLoads.shift().resolve()');
    assert.equal(await switching, true);
    assert.notEqual(run('capturedPhoto'), firstImage);
    assert.equal(run('selectedPhotoId'), 2);
    assert.equal(activeUrls.has(firstUrl), false);
    assert.equal(activeUrls.size, 4);

    const secondImage = run('capturedPhoto');
    const failed = run('showPhoto(photos.get(3))');
    run('imageLoads.shift().reject(new Error("decode failed"))');
    assert.equal(await failed, false);
    assert.equal(run('capturedPhoto'), secondImage);
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(run('selectedPhotoId'), 2);
    assert.equal(run('capturePhase'), 'review');
    assert.equal(activeUrls.size, 4);

    const cancelled = run('showPhoto(photos.get(3))');
    run('resetCamera(); imageLoads.shift().resolve()');
    assert.equal(await cancelled, false);
    assert.equal(elements.get('#photo-review').hidden, true);
    assert.equal(run('selectedPhotoId'), null);
    assert.equal(activeUrls.size, 3);
  } finally {
    run('clearPhoto(); photos.clear();');
    assert.equal(activeUrls.size, 0);
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
    assert.equal(timer.disabled, false);
    assert.equal(elements.get('#resolution').disabled, false);
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
    () => document.listeners.get('keydown')({ key: 'Escape', preventDefault() {} }),
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

test('keyboard shortcuts dispatch the intended actions and ignore repeats, modifiers, and form controls', () => {
  const { run, document, elements } = setup();
  run(`var shots = 0, saves = 0, fullscreens = 0, closes = 0, navigated = [];
    startShooting = () => shots++;
    downloadSelectedPhoto = () => saves++;
    toggleFullscreen = async () => fullscreens++;
    returnToCamera = async () => closes++;
    showPhoto = async photo => { navigated.push(photo.id); selectedPhotoId = photo.id; };
    for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);
    capturePhase = 'review'; selectedPhotoId = 2;`);
  const press = (key, extra = {}) => {
    let prevented = false;
    document.listeners.get('keydown')({ key, preventDefault() { prevented = true; }, ...extra });
    return prevented;
  };
  try {
    elements.get('#fullscreen').disabled = false;
    elements.get('#shutter').disabled = false;
    run("capturePhase = 'live';");
    assert.equal(press(' '), true);
    assert.equal(run('shots'), 1);
    run("capturePhase = 'review';");
    press(' ');
    assert.equal(run('closes'), 1);
    assert.equal(run('shots'), 1);
    assert.equal(press('s'), true);
    assert.equal(run('saves'), 1);
    assert.equal(press('F'), true);
    assert.equal(run('fullscreens'), 1);
    press('ArrowLeft');
    assert.equal(run('selectedPhotoId'), 1);
    press('ArrowLeft');
    assert.equal(run('navigated.length'), 1);
    press('ArrowRight');
    assert.equal(run('selectedPhotoId'), 2);
    run('selectedPhotoId = 3;');
    press('ArrowLeft', { repeat: true });
    assert.equal(run('selectedPhotoId'), 2);
    press('ArrowLeft', { repeat: true });
    assert.equal(run('selectedPhotoId'), 1);
    run('selectedPhotoId = 2;');
    press('Escape');
    assert.equal(run('closes'), 2);
    document.fullscreenElement = {};
    assert.equal(press('Escape'), false);
    assert.equal(run('closes'), 2);
    document.fullscreenElement = null;
    for (const extra of [{repeat: true}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}, {target: {closest: () => ({})}}]) {
      assert.equal(press(' ', extra), false);
      assert.equal(press('s', extra), false);
    }
    assert.equal(run('shots'), 1);
    assert.equal(run('saves'), 1);
    run("capturePhase = 'capturing';");
    press('s'); press('ArrowLeft');
    assert.equal(run('saves'), 1);
    assert.equal(run('selectedPhotoId'), 2);
    run("capturePhase = 'live'; selectedPhotoId = null; stream = {};");
    press('ArrowLeft');
    assert.equal(run('selectedPhotoId'), 3);
    run("capturePhase = 'live'; selectedPhotoId = null;");
    press('ArrowRight');
    assert.equal(run('selectedPhotoId'), 1);
    run('selectedPhotoId = null; photos.clear();');
    press('ArrowLeft'); press('ArrowRight');
    assert.equal(run('selectedPhotoId'), null);
  } finally {
    run('clearPhoto(); photos.clear();');
  }
});

test('Delete, Enter and help shortcuts respect selection, camera state and the help dialog', () => {
  const { run, document, elements } = setup();
  run(`var deletions = 0, cameraStarts = 0, shots = 0, previewCloses = 0;
    deleteSelectedPhoto = () => deletions++;
    openCamera = async () => cameraStarts++;
    startShooting = () => shots++;
    returnToCamera = async () => previewCloses++;`);
  const press = (key, extra = {}) => document.listeners.get('keydown')({key, preventDefault() {}, ...extra});
  press('Delete');
  assert.equal(run('deletions'), 0);
  press('Enter');
  assert.equal(run('cameraStarts'), 1);
  run('busy = true;');
  press('Enter');
  run('busy = false; stream = {};');
  press('Enter');
  assert.equal(run('cameraStarts'), 1);
  run("capturePhase = 'review'; selectedPhotoId = 1;");
  press('Delete');
  assert.equal(run('deletions'), 1);
  press('Delete', {repeat: true});
  press('Backspace');
  assert.equal(run('deletions'), 2);
  press('?');
  assert.equal(elements.get('#shortcut-help').open, true);
  press('Delete'); press('Enter'); press(' ');
  assert.equal(run('deletions'), 2);
  assert.equal(run('shots'), 0);
  assert.equal(run('cameraStarts'), 1);
  press('Escape');
  assert.equal(elements.get('#shortcut-help').open, false);
  assert.equal(run('previewCloses'), 0);
  press('?'); press('?');
  assert.equal(elements.get('#shortcut-help').open, false);
});

test('deletion selects the newer neighbor, falls back to the older neighbor, and returns to the camera for the last photo', async () => {
  const { run, elements, activeUrls } = setup();
  try {
    run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
      for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(2))');
    await run('deleteSelectedPhoto()');
    assert.equal(run('selectedPhotoId'), 3);
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(run('photos.get(2)'), undefined);
    await run('deleteSelectedPhoto()');
    assert.equal(run('selectedPhotoId'), 1);
    await run('deleteSelectedPhoto()');
    assert.equal(run('selectedPhotoId'), null);
    assert.equal(run('capturePhase'), 'live');
    assert.equal(elements.get('#photo-review').hidden, true);
    assert.equal(activeUrls.size, 1); // The last deleted thumbnail is retained for undo.
  } finally {
    run('resetCamera(); photos.clear();');
  }
});

test('deletion keeps the displayed image, position and gallery stable until its neighbor is ready', async () => {
  const { run, elements, activeUrls } = setup();
  try {
    run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
      for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(2))');
    const image = run('capturedPhoto');
    const thumbnails = elements.get('#gallery-list').children;
    run(`var finishDecode;
      var originalCreate = document.createElement;
      document.createElement = tag => {
        const image = originalCreate(tag);
        if (tag === 'img') image.decode = function () {
          return this.id === 'captured-photo' ? new Promise(resolve => { finishDecode = resolve; }) : Promise.resolve();
        };
        return image;
      };`);
    const deleting = run('deleteSelectedPhoto()');
    assert.equal(run('capturedPhoto'), image);
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(elements.get('#photo-position').textContent, '2 / 3');
    assert.equal(elements.get('#photo-position').hidden, false);
    assert.equal(elements.get('#photo-count').hidden, true);
    assert.equal(elements.get('#gallery-list').children, thumbnails);
    run('finishDecode()');
    await deleting;
    assert.equal(run('selectedPhotoId'), 3);
    assert.equal(elements.get('#photo-position').textContent, '2 / 2');
    assert.equal(elements.get('#gallery-list').children.length, 2);
  } finally {
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});

test('undo via keyboard restores and selects the deleted photo and scrolls its thumbnail into view', async () => {
  const { run, elements, document, activeUrls } = setup();
  try {
    run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
      for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(2))');
    assert.equal(elements.get('#photo-position').textContent, '2 / 3');
    let selected = elements.get('#gallery-list').children.find(button => button['aria-pressed'] === 'true');
    assert.equal(selected.dataset.photoId, '2');
    assert.equal(selected.scrollOptions.inline, 'nearest');
    assert.equal(selected.scrollOptions.block, 'nearest');
    await run('deleteSelectedPhoto()');
    assert.equal(elements.get('#photo-position').textContent, '2 / 2');
    assert.equal(elements.get('#undo-delete').hidden, false);
    assert.equal(elements.get('#undo-delete').disabled, false);
    run('var undoAttempt; var originalUndo = undoDelete; undoDelete = () => undoAttempt = originalUndo();');
    const press = extra => document.listeners.get('keydown')({ key: 'z', metaKey: true, preventDefault() {}, ...extra });
    press({repeat: true});
    press({target: {closest: () => ({})}});
    assert.equal(run('undoAttempt'), undefined);
    press({});
    await run('undoAttempt');
    assert.equal(run('selectedPhotoId'), 2);
    assert.equal(elements.get('#photo-position').textContent, '2 / 3');
    assert.equal(run('photos.canUndo'), false);
    assert.equal(elements.get('#undo-delete').hidden, true);
    assert.deepEqual(elements.get('#gallery-list').children.map(button => button.dataset.photoId), ['3', '2', '1']);
    selected = elements.get('#gallery-list').children.find(button => button['aria-pressed'] === 'true');
    assert.equal(selected.scrollOptions.inline, 'nearest');
  } finally {
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});

test('photo position numbers run from oldest to newest and disappear when the preview closes', async () => {
  const { run, elements } = setup();
  try {
    run(`reducedMotion.matches = true;
      for (let i = 0; i < 3; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(1))');
    assert.equal(elements.get('#photo-position').textContent, '1 / 3');
    assert.equal(elements.get('#photo-count').hidden, true);
    await run('showPhoto(photos.get(3))');
    assert.equal(elements.get('#photo-position').textContent, '3 / 3');
    await run('returnToCamera()');
    assert.equal(elements.get('#photo-position').hidden, true);
    assert.equal(elements.get('#photo-position').textContent, '');
    assert.equal(elements.get('#photo-count').hidden, false);
    assert.equal(elements.get('#photo-count').textContent, '3');
  } finally {
    run('clearPhoto(); photos.clear();');
  }
});

test('leaving warns only for unsaved photos and updates after download, deletion, and undo without clearing cancelled navigation', async () => {
  const { run, context, activeUrls, elements } = setup();
  const listeners = context.window.listeners;
  try {
    assert.equal(listeners.has('beforeunload'), false);
    run(`for (let i = 0; i < 2; i++) photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);
      renderGallery();`);
    assert.equal(listeners.has('beforeunload'), true);
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    listeners.get('beforeunload')(event);
    assert.equal(prevented, true);
    assert.equal(event.returnValue, '');
    assert.equal(run('photos.list().length'), 2);
    await run('showPhoto(photos.get(1))');
    const firstThumbnail = elements.get('#gallery-list').children.find(button => button.dataset.photoId === '1');
    assert.equal(firstThumbnail.dataset.downloaded, 'false');
    run('downloadSelectedPhoto()');
    assert.equal(firstThumbnail.dataset.downloaded, 'true');
    assert.match(firstThumbnail.title, /^#1 \d{2}:\d{2}:\d{2}$/);
    assert(firstThumbnail['aria-label'].includes('ダウンロード済み'));
    assert.equal(listeners.has('beforeunload'), true); // Photo 2 is still unsaved.
    await run('showPhoto(photos.get(2))');
    await run('deleteSelectedPhoto()');
    assert.equal(listeners.has('beforeunload'), false);
    await run('undoDelete()');
    assert.equal(listeners.has('beforeunload'), true);
    run('downloadSelectedPhoto()');
    assert.equal(listeners.has('beforeunload'), false);
    await run('deleteSelectedPhoto()');
    await run('undoDelete()');
    assert.equal(elements.get('#gallery-list').children.find(button => button.dataset.photoId === '2').dataset.downloaded, 'true');
    assert.equal(listeners.has('beforeunload'), false); // Restoring a downloaded photo keeps its saved state.
  } finally {
    run('resetCamera(); photos.clear(); syncUnloadWarning(); for (const url of downloads.keys()) releaseDownload(url);');
    assert.equal(activeUrls.size, 0);
    assert.equal(listeners.has('beforeunload'), false);
  }
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
      assert.equal(activeUrls.size, count); // Reduced motion returns immediately and retains only thumbnails.
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
      await run(`var downloadUrl = URL.createObjectURL(photos.get(selectedPhotoId).original);
        downloads.set(downloadUrl, { photoId: selectedPhotoId, timer: setTimeout(() => releaseDownload(downloadUrl), 60000) });
        deleteSelectedPhoto();`);
      assert.equal(run('photos.list().length'), remaining - 1);
      assert.equal(run('thumbnailImages.size'), remaining - 1);
      assert.equal(run('downloads.size'), 0);
      assert.equal(activeUrls.size, remaining > 1 ? remaining + 1 : 1);
    }
    assert.equal(elements.get('#gallery-list').children.length, 0);
    assert.equal(elements.get('#captured-photo').src, undefined);
  } finally {
    run('clearPhoto(); photos.clear(); for (const url of downloads.keys()) releaseDownload(url);');
  }
});

test('shooting during a return animation preserves the new preview when the old animation finishes', async () => {
  const { run, elements, pending, completion, activeUrls } = setup({ deferPng: true });
  run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
    timer.value = '0'; setBusy(false);`);
  try {
    await run('showPhoto(photos.add(new Blob(["first"]), new Blob(["jpg"]), 1920, 1080))');
    const returning = run('returnToCamera()');
    const finishOldAnimation = completion();
    const departingAnimation = run('[...returningPhotos.values()][0].animation');
    // Save the old completion callback before the next capture creates a flash.
    run('var originalCapture = capturePhoto; var nextCapture; capturePhoto = () => nextCapture = originalCapture();');
    assert.equal(elements.get('#shutter').disabled, false);
    run('startShooting()');
    assert.equal(pending.length, 1);
    pending[0].callback(new Blob(['second'], { type: 'image/png' }));
    await run('nextCapture');
    assert.equal(departingAnimation.cancelled, false);
    assert.equal(run('returningPhotos.size'), 2);
    const finishNewAnimation = completion();
    assert.equal(activeUrls.size, 4); // Two thumbnails, the departing image, and the new preview.
    finishOldAnimation();
    await returning;
    assert.equal(run('returningPhotos.size'), 1);
    assert.equal(activeUrls.size, 3);
    assert.equal(run('capturePhase'), 'returning');
    assert.equal(run('captureReturnInProgress'), true);
    assert.equal(elements.get('#photo-review').hidden, false);
    assert.equal(run('photos.list().length'), 2);
    assert.equal(elements.get('#gallery-list').children.length, 1);
    finishNewAnimation();
    for (let i = 0; i < 4; i++) await run('Promise.resolve()');
    assert.equal(run('capturePhase'), 'live');
    assert.equal(activeUrls.size, 2);
  } finally {
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});

test('closing a preview deselects its thumbnail immediately and allows reopening during the return animation', async () => {
  const { run, elements, completion, activeUrls } = setup();
  try {
    run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
      photos.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);`);
    await run('showPhoto(photos.get(1))');
    const returning = run('returnToCamera()');
    const finishReturn = completion();
    assert.equal(run('selectedPhotoId'), null);
    const thumbnail = elements.get('#gallery-list').children[0];
    assert.equal(thumbnail['aria-pressed'], 'false');
    assert.equal(thumbnail.disabled, false);
    await run('showPhoto(photos.get(1))');
    assert.equal(run('selectedPhotoId'), 1);
    assert.equal(run('capturePhase'), 'review');
    assert.equal(run('returningPhotos.size'), 1);
    finishReturn();
    await returning;
    assert.equal(run('selectedPhotoId'), 1);
    assert.equal(elements.get('#photo-review').hidden, false);
  } finally {
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});

test('overlapping return animations keep the older image in front and finish independently', async () => {
  const { run, completion, activeUrls } = setup();
  run(`stream = {getTracks: () => [], getVideoTracks: () => [{getSettings: () => ({})}]};
    timer.value = '0'; setBusy(false);`);
  try {
    await run('showPhoto(photos.add(new Blob(["png"]), new Blob(["jpg"]), 1920, 1080))');
    const firstReturn = run('returnToCamera()');
    const finishFirst = completion();
    const firstElement = run('[...returningPhotos.keys()][0]');
    const firstAnimation = run('returningPhotos.get([...returningPhotos.keys()][0]).animation');
    await run('showPhoto(photos.add(new Blob(["png"]), new Blob(["jpg"]), 1920, 1080))');
    const secondReturn = run('returnToCamera()');
    const finishSecond = completion();
    const secondElement = run('[...returningPhotos.keys()][1]');
    const secondAnimation = run('returningPhotos.get([...returningPhotos.keys()][1]).animation');
    assert.equal(run('returningPhotos.size'), 2);
    assert(Number(firstElement.style.zIndex) > Number(secondElement.style.zIndex));
    assert.equal(firstAnimation.cancelled, false);
    assert.equal(secondAnimation.cancelled, false);
    finishFirst();
    await firstReturn;
    assert.equal(run('returningPhotos.size'), 1);
    assert.equal(run('capturePhase'), 'returning');
    assert.equal(secondAnimation.cancelled, false);
    finishSecond();
    await secondReturn;
    assert.equal(run('returningPhotos.size'), 0);
    assert.equal(run('capturePhase'), 'live');
    assert.equal(activeUrls.size, 2);
  } finally {
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
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
    run('resetCamera(); photos.clear();');
    assert.equal(activeUrls.size, 0);
  }
});
