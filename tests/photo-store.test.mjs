import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhotoStore, photoFilename } from '../src/photo-store.ts';
import { returnKeyframes } from '../src/return-effects.ts';

test('retain original PNG, allocate URLs only for thumbnails, release deleted records', () => {
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const allocated = [];
  const released = [];
  URL.createObjectURL = blob => { allocated.push(blob); return `blob:test-${allocated.length}`; };
  URL.revokeObjectURL = url => released.push(url);
  try {
    const store = new PhotoStore();
    const original = new Blob(['original'], { type: 'image/png' });
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' });
    const first = store.add(original, thumbnail, 1920, 1080);
    const second = store.add(original, thumbnail, 3840, 2160);
    assert.equal(first.original, original);
    assert.deepEqual(allocated, [thumbnail, thumbnail]);
    assert.deepEqual(store.list().map(photo => photo.id), [second.id, first.id]);
    store.remove(first.id);
    store.remove(first.id);
    assert.equal(store.get(first.id), undefined);
    assert.deepEqual(released, [first.thumbnailUrl]);
    store.clear();
    assert.deepEqual(store.list(), []);
    assert.deepEqual(released, [first.thumbnailUrl, second.thumbnailUrl]);
    const third = store.add(original, thumbnail, 1920, 1080);
    assert(third.id > second.id);
    store.clear();
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});

test('undo restores multiple deletions in reverse order and releases only discarded history', () => {
  const revoke = URL.revokeObjectURL;
  const released = [];
  URL.revokeObjectURL = url => { released.push(url); revoke(url); };
  const store = new PhotoStore();
  try {
    const add = () => store.add(new Blob(['png']), new Blob(['jpg']), 1920, 1080);
    const first = add();
    const second = add();
    const third = add();
    store.removeUndoable(second.id);
    assert.equal(store.canUndo, true);
    assert.equal(released.length, 0);
    assert.equal(store.undoRemove(), second);
    assert.deepEqual(store.list().map(photo => photo.id), [third.id, second.id, first.id]);
    assert.equal(store.canUndo, false);
    assert.equal(store.undoRemove(), null);
    store.removeUndoable(first.id);
    store.removeUndoable(third.id);
    assert.deepEqual(released, []);
    assert.equal(store.undoRemove(), third);
    assert.equal(store.canUndo, true);
    assert.equal(store.get(first.id), undefined);
    assert.equal(store.undoRemove(), first);
    assert.deepEqual(store.list().map(photo => photo.id), [third.id, second.id, first.id]);
    store.removeUndoable(first.id);
    store.removeUndoable(second.id);
    store.clearUndoHistory();
    assert.deepEqual(released, [first.thumbnailUrl, second.thumbnailUrl]);
    assert.equal(store.canUndo, false);
    assert.equal(store.undoRemove(), null);
    assert.equal(store.get(third.id), third);
    store.removeUndoable(third.id);
    store.clear();
    assert.equal(store.canUndo, false);
    assert.equal(store.undoRemove(), null);
    assert.equal(new Set(released).size, 3);
    assert.equal(released.length, 3);
  } finally {
    store.clear();
    URL.revokeObjectURL = revoke;
  }
});

test('PNG filenames include a local timestamp without a photo number', () => {
  assert.equal(photoFilename({ id: 12, createdAt: new Date(2026, 9, 2, 3, 4, 5) }), 'photo-20261002-030405.png');
});

test('shrink destination uses the actual thumbnail size and position', () => {
  const source = { left: 10, top: 20, width: 1920, height: 1080 };
  const target = { left: 100, top: 800, width: 96, height: 54 };
  const frames = returnKeyframes(source, target);
  assert.equal(frames[1].transform, 'translate(-822px, 267px) scale(0.05)');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].opacity, 1);
  assert.equal(frames[1].offset, 1);
  const compact = returnKeyframes(source, { ...target, width: 56, height: 32 });
  assert(compact[1].transform.includes(`scale(${56 / 1920})`));
});
