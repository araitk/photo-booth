import { PhotoStore, type Photo } from './photo-store';
import { loadSettings, persistSettings } from './settings';
import { applyLanguage, getLanguage, initLanguage, translateCurrentText, type Language } from './i18n';
import { createCameraController } from './camera-controller';
import { createCaptureController } from './capture-controller';
import { createView, type GalleryChange } from './view';

const savedSettings = loadSettings();
initLanguage(savedSettings.language);
applyLanguage();

export const photos = new PhotoStore();
export const view = createView(id => {
  if (capture.getActions().galleryLocked) return;
  if (id === capture.getState().selectedPhotoId) void capture.returnToCamera();
  else {
    const photo = photos.get(id);
    if (photo) void capture.showPhoto(photo);
  }
});
const { video, startButton, resolution, cameraSelect, languageSelect, fullscreenButton,
  message, status, shutter, timer, photoReview, downloadButton, deleteButton, undoButton,
  shortcutHelp, shortcutHelpButton, closeShortcutHelp } = view.elements;
languageSelect.value = getLanguage();
if (savedSettings.timer !== undefined) timer.value = savedSettings.timer;
if (savedSettings.resolution !== undefined) resolution.value = savedSettings.resolution;

export const camera = createCameraController({
  cameraId: savedSettings.cameraId ?? '', resolution: resolution.value,
  attachStream: view.attachStream,
  canConfigure: () => ['live', 'review'].includes(capture.getState().capturePhase),
  changed: () => { render(); saveSettings(); },
  devicesChanged: () => view.renderDevices(camera.getState()),
  reset: () => { view.detachStream(); capture.reset(); },
  notice: text => { status.textContent = text; },
  error: text => { message.textContent = text; },
});
export const capture = createCaptureController({
  camera, view, photos, timerSeconds: () => Number(timer.value),
  changed: () => { render(); camera.schedulePendingChanges(); },
  photosChanged: renderGallery,
  unsavedChanged: syncUnloadWarning,
  notice: text => { status.textContent = text; },
});

function render() {
  view.renderCamera(camera.getState(), capture.getState());
  view.renderControls(camera.getState(), capture.getState(), capture.getActions(), photos.canUndo);
}

function renderGallery(change?: GalleryChange) {
  syncUnloadWarning();
  const { selectedPhotoId, pendingPhotoId } = capture.getState();
  view.renderGallery(photos.list(), selectedPhotoId, pendingPhotoId, capture.getActions().galleryLocked, change);
}

function saveSettings() {
  const state = camera.getState();
  persistSettings({ timer: timer.value, resolution: state.resolution, cameraId: state.preferredCameraId, language: getLanguage() });
}

let unloadWarningActive = false;
let helpOpenedByPointer = false;
const pointerSelectedControls = new WeakSet<HTMLSelectElement>();

for (const control of [cameraSelect, resolution, timer, languageSelect]) {
  control.addEventListener('pointerdown', () => { pointerSelectedControls.add(control); });
  control.addEventListener('keydown', () => { pointerSelectedControls.delete(control); });
}

function releaseSelectFocus(control: HTMLSelectElement) {
  if (!pointerSelectedControls.has(control)) return;
  pointerSelectedControls.delete(control);
  control.blur();
}

function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (!photos.hasUnsavedPhotos) return;
  event.preventDefault();
  event.returnValue = '';
}

function syncUnloadWarning() {
  const needed = photos.hasUnsavedPhotos;
  if (needed === unloadWarningActive) return;
  if (needed) window.addEventListener('beforeunload', warnBeforeUnload);
  else window.removeEventListener('beforeunload', warnBeforeUnload);
  unloadWarningActive = needed;
}

startButton.addEventListener('click', () => { void camera.openCamera(); });
cameraSelect.addEventListener('change', async () => {
  releaseSelectFocus(cameraSelect);
  await camera.selectCamera(cameraSelect.value);
});
resolution.addEventListener('change', async () => {
  releaseSelectFocus(resolution);
  await camera.selectResolution(resolution.value);
});
timer.addEventListener('change', () => { releaseSelectFocus(timer); saveSettings(); });
navigator.mediaDevices?.addEventListener('devicechange', () => { void camera.updateCameraList(); });
shutter.addEventListener('click', () => { void capture.startShooting(); });
downloadButton.addEventListener('click', () => capture.downloadSelectedPhoto());
deleteButton.addEventListener('click', () => { void capture.deleteSelectedPhoto(); });
undoButton.addEventListener('click', () => { void capture.undoDelete(); });
photoReview.addEventListener('click', () => { void capture.returnToCamera(); });
video.addEventListener('loadeddata', render);
video.addEventListener('resize', render);
document.addEventListener('visibilitychange', () => { if (document.hidden) capture.cancelCountdown(); });
window.addEventListener('pagehide', event => {
  camera.stop();
  if (!event.persisted) {
    photos.clear();
    syncUnloadWarning();
    view.clearThumbnails();
    view.releaseDownloads();
  }
});

shortcutHelpButton.addEventListener('click', event => {
  if (shortcutHelp.open) return;
  helpOpenedByPointer = event.detail > 0;
  shortcutHelp.showModal();
});
shortcutHelp.addEventListener('close', () => {
  if (helpOpenedByPointer && document.activeElement === shortcutHelpButton) shortcutHelpButton.blur();
  helpOpenedByPointer = false;
});
closeShortcutHelp.addEventListener('click', () => { shortcutHelp.close(); });
document.addEventListener('keydown', event => {
  const { stream, busy } = camera.getState();
  const { capturePhase, selectedPhotoId, lastViewedPhotoId, captureReturnInProgress } = capture.getState();
  const actions = capture.getActions();
  const arrowKey = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  if ((event.repeat && !arrowKey) || event.isComposing || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z' && !event.shiftKey && !shortcutHelp.open && actions.canUndo) {
      event.preventDefault();
      void capture.undoDelete();
    }
    return;
  }
  if (shortcutHelp.open) {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      shortcutHelp.close();
    }
    return;
  }
  if (event.key === '?') {
    event.preventDefault();
    helpOpenedByPointer = false;
    shortcutHelp.showModal();
    return;
  }
  if (event.key === 'Enter') {
    if (!target?.closest?.('button, a') && !stream && !busy) {
      event.preventDefault();
      void camera.openCamera();
    }
    return;
  }
  if (event.key === 'Escape') {
    if (capturePhase === 'countdown') {
      event.preventDefault();
      capture.cancelCountdown();
    } else if (capturePhase === 'review' && !document.fullscreenElement) {
      event.preventDefault();
      void capture.returnToCamera();
    }
    return;
  }
  if (event.key === ' ') {
    if (target?.closest?.('button, a')) return;
    if (captureReturnInProgress) {
      event.preventDefault();
      capture.dismissCaptureReview();
      return;
    }
    if (!busy && capturePhase === 'review') {
      event.preventDefault();
      void capture.returnToCamera();
      return;
    }
    if (actions.canShoot) {
      event.preventDefault();
      capture.startShooting();
    }
    return;
  }
  if (event.key.toLowerCase() === 'f' && !fullscreenButton.disabled) {
    event.preventDefault();
    void view.toggleFullscreen();
    return;
  }
  if (busy) return;
  if (event.key === 'ArrowUp') {
    if (captureReturnInProgress) {
      event.preventDefault();
      capture.dismissCaptureReview();
    } else if (capturePhase === 'review') {
      event.preventDefault();
      void capture.returnToCamera();
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    if (capturePhase === 'live' || capturePhase === 'returning') {
      const photo = (lastViewedPhotoId === null ? undefined : photos.get(lastViewedPhotoId)) ?? photos.list()[0];
      if (photo) {
        event.preventDefault();
        void capture.showPhoto(photo);
      }
    }
    return;
  }
  if (event.key.toLowerCase() === 'z' && !event.shiftKey && actions.canUndo) {
    event.preventDefault();
    void capture.undoDelete();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const list = photos.list();
    let next: Photo | undefined;
    if (capturePhase === 'review' && selectedPhotoId !== null) {
      const index = list.findIndex(photo => photo.id === selectedPhotoId);
      next = list[index + (event.key === 'ArrowLeft' ? 1 : -1)];
    } else if (stream && (capturePhase === 'live' || capturePhase === 'returning')) {
      next = event.key === 'ArrowLeft' ? list[0] : list.at(-1);
    } else {
      return;
    }
    event.preventDefault();
    if (next) void capture.showPhoto(next);
    return;
  }
  if (capturePhase !== 'review' || selectedPhotoId === null) return;
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    capture.downloadSelectedPhoto();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    capture.deleteSelectedPhoto();
  }
});

fullscreenButton.addEventListener('click', event => {
  if (event.detail > 0) fullscreenButton.blur();
  void view.toggleFullscreen();
});
document.addEventListener('fullscreenchange', view.updateFullscreen);
languageSelect.addEventListener('change', () => {
  releaseSelectFocus(languageSelect);
  const currentMessage = message.textContent ?? '';
  applyLanguage(languageSelect.value as Language);
  status.textContent = translateCurrentText(status.textContent ?? '');
  message.textContent = translateCurrentText(currentMessage);
  view.translatePhoto();
  saveSettings();
  render();
  view.updateFullscreen();
  renderGallery();
  view.renderDevices(camera.getState());
  void camera.updateCameraList();
});

render();
void camera.updateCameraList();
