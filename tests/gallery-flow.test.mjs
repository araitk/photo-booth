import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('append each thumbnail and update count only after the return animation finishes', async () => {
  const elements = new Map();
  let finishAnimation;
  let nextUrl = 0;
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
      animate(_frames, options) {
        assert.equal(options.duration, 1000);
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
    createElement: () => element(), createTextNode: text => text, addEventListener() {},
  };
  const context = vm.createContext({
    document, navigator: {},
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    ResizeObserver: class { observe() {} },
    URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL() {} },
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
      finishAnimation();
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
