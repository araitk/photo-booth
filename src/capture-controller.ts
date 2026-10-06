import { type Photo, PhotoStore } from './photo-store';
import type { TranslationMessage } from './i18n';
import type { CameraController } from './camera-controller';
import type { BoothView, GalleryChange } from './view';

export interface CaptureState {
  readonly capturePhase: 'live' | 'countdown' | 'capturing' | 'review' | 'returning';
  readonly selectedPhotoId: number | null;
  readonly lastViewedPhotoId: number | null;
  readonly pendingPhotoId: number | null;
  readonly captureReturnInProgress: boolean;
}

export interface CaptureActions {
  readonly canShoot: boolean;
  readonly canDownload: boolean;
  readonly canDelete: boolean;
  readonly canUndo: boolean;
  readonly galleryLocked: boolean;
}

interface CaptureOptions {
  camera: Pick<CameraController, 'getState'>;
  view: BoothView;
  photos: PhotoStore;
  timerSeconds: () => number;
  changed: () => void;
  photosChanged: (change?: GalleryChange) => void;
  unsavedChanged: () => void;
  notice: (message: TranslationMessage | null) => void;
}

export function createCaptureController(options: CaptureOptions) {
  const { camera, view, photos } = options;
  const video = view.elements.video;
  let capturePhase: CaptureState['capturePhase'] = 'live';
  let selectedPhotoId: number | null = null;
  let lastViewedPhotoId: number | null = null;
  let pendingPhotoId: number | null = null;
  let captureReturnInProgress = false;
  let captureVersion = 0;
  let countdownTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingGalleryChange: GalleryChange | undefined;

  function getState(): CaptureState {
    return { capturePhase, selectedPhotoId, lastViewedPhotoId, pendingPhotoId, captureReturnInProgress };
  }

  function getActions(): CaptureActions {
    const { busy, stream } = camera.getState();
    const locked = busy || ['countdown', 'capturing', 'returning'].includes(capturePhase);
    return {
      canShoot: !busy && !captureReturnInProgress && Boolean(stream)
        && ['live', 'countdown', 'returning'].includes(capturePhase) && video.readyState >= 2 && video.videoWidth > 0,
      canDownload: !locked && selectedPhotoId !== null,
      canDelete: !locked && selectedPhotoId !== null,
      canUndo: !locked && photos.canUndo,
      galleryLocked: busy || capturePhase === 'countdown' || capturePhase === 'capturing'
        || (pendingPhotoId !== null && capturePhase !== 'returning'),
    };
  }

  function clearPhoto(pendingId: number | null = null) {
    cancelCountdown();
    captureReturnInProgress = false;
    captureVersion++;
    selectedPhotoId = null;
    pendingPhotoId = pendingId;
    capturePhase = 'live';
    view.clearPhoto(camera.getState().stream);
    photosChanged();
    options.changed();
  }

  async function showPhoto(photo: Photo, automatic = false): Promise<boolean> {
    if (!photos.get(photo.id)) return false;
    const switching = selectedPhotoId !== null || captureReturnInProgress;
    if (!switching) clearPhoto(automatic ? photo.id : null);
    captureReturnInProgress = false;
    const version = ++captureVersion;
    capturePhase = 'capturing';
    options.changed();
    let prepared: Awaited<ReturnType<BoothView['preparePhoto']>> | undefined;
    try {
      prepared = await view.preparePhoto(photo);
      if (version !== captureVersion) return false;
      view.showPreparedPhoto(prepared, photo);
      prepared = undefined;
      selectedPhotoId = photo.id;
      lastViewedPhotoId = photo.id;
      pendingPhotoId = automatic ? photo.id : null;
      capturePhase = 'review';
      photosChanged();
      if (automatic) view.scrollGalleryToStart();
      options.changed();
      if (automatic) void returnToCamera(true);
      return true;
    } catch {
      if (version === captureVersion) {
        if (switching) { capturePhase = 'review'; options.changed(); }
        else clearPhoto();
        options.notice({ key: '写真を表示できませんでした。' });
      }
      return false;
    } finally {
      if (prepared) view.discardPreparedPhoto(prepared);
    }
  }

  function cancelCountdown() {
    clearTimeout(countdownTimer);
    countdownTimer = undefined;
    view.renderCountdown(null);
    if (capturePhase === 'countdown') { capturePhase = 'live'; options.changed(); }
  }

  function startShooting() {
    if (capturePhase === 'countdown') { cancelCountdown(); return; }
    if (!getActions().canShoot) return;
    const seconds = options.timerSeconds();
    if (![3, 5, 10].includes(seconds)) return capturePhoto();
    if (capturePhase === 'returning') clearPhoto();
    capturePhase = 'countdown';
    options.notice(null);
    options.changed();
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      if (capturePhase !== 'countdown') return;
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) { cancelCountdown(); void capturePhoto(); return; }
      const secondsLeft = Math.ceil(remaining / 1000);
      view.renderCountdown(secondsLeft);
      countdownTimer = setTimeout(tick, remaining - (secondsLeft - 1) * 1000);
    };
    tick();
  }

  async function capturePhoto() {
    if (!getActions().canShoot || capturePhase === 'countdown') return;
    const captureCanvas = document.createElement('canvas');
    capturePhase = 'capturing';
    options.changed();
    const version = ++captureVersion;
    options.notice(null);
    const context = captureCanvas.getContext('2d');
    if (!context) { clearPhoto(); options.notice({ key: '撮影できませんでした。もう一度お試しください。' }); return; }
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    try {
      // Draw the source frame directly: CSS mirroring and UI overlays are excluded.
      context.drawImage(video, 0, 0);
      view.flashCapture();
      const width = captureCanvas.width;
      const height = captureCanvas.height;
      const thumbnailCanvas = document.createElement('canvas');
      thumbnailCanvas.width = Math.min(240, width);
      thumbnailCanvas.height = Math.max(1, Math.round(height * thumbnailCanvas.width / width));
      const thumbnailContext = thumbnailCanvas.getContext('2d');
      if (!thumbnailContext) throw new Error('thumbnail-failed');
      thumbnailContext.drawImage(captureCanvas, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
      const [blob, thumbnail] = await Promise.all([
        encodeCanvas(captureCanvas, 'image/png'),
        encodeCanvas(thumbnailCanvas, 'image/jpeg', 0.8).finally(() => { thumbnailCanvas.width = 0; thumbnailCanvas.height = 0; }),
      ]);
      if (version !== captureVersion || !camera.getState().stream) return;
      const photo = photos.add(blob, thumbnail, width, height);
      options.unsavedChanged();
      if (!await showPhoto(photo, true)) { photos.remove(photo.id); photosChanged(); }
      else { photos.clearUndoHistory(); options.changed(); }
    } catch {
      if (version === captureVersion) { clearPhoto(); options.notice({ key: '撮影できませんでした。もう一度お試しください。' }); }
    } finally { captureCanvas.width = 0; captureCanvas.height = 0; }
  }

  async function returnToCamera(afterCapture = false) {
    if (capturePhase !== 'review') return;
    const destination = view.returnDestination(selectedPhotoId, pendingPhotoId);
    capturePhase = 'returning';
    captureReturnInProgress = afterCapture;
    selectedPhotoId = null;
    photosChanged();
    options.changed();
    const version = captureVersion;
    if (view.reducedMotion) { clearPhoto(); return; }
    await view.returnPhoto(afterCapture, destination);
    if (version !== captureVersion) return;
    clearPhoto();
  }

  function dismissCaptureReview() {
    if (!captureReturnInProgress) return;
    captureReturnInProgress = false;
    view.hidePhoto();
    options.changed();
  }

  function downloadSelectedPhoto() {
    if (!getActions().canDownload || selectedPhotoId === null) return;
    const photo = photos.get(selectedPhotoId);
    if (!photo) return;
    view.downloadPhoto(photo);
    photos.markDownloaded(photo.id);
    photosChanged();
  }

  async function deleteSelectedPhoto() {
    if (!getActions().canDelete || selectedPhotoId === null) return;
    const id = selectedPhotoId;
    const list = photos.list();
    const index = list.findIndex(photo => photo.id === id);
    const next = list[index - 1] || list[index + 1];
    photos.removeUndoable(id);
    view.releasePhotoDownloads(id);
    // Keep the gallery and selection stable until the replacement image is ready.
    pendingGalleryChange = { kind: 'delete', id };
    if (next) {
      const shown = await showPhoto(next);
      if (!shown && selectedPhotoId === id) clearPhoto();
    } else clearPhoto();
  }

  function photosChanged(change = pendingGalleryChange) {
    pendingGalleryChange = undefined;
    options.photosChanged(change);
  }

  async function undoDelete() {
    if (!getActions().canUndo) return;
    const photo = photos.undoRemove();
    if (!photo) return;
    photosChanged({ kind: 'restore', id: photo.id });
    await showPhoto(photo);
  }

  function reset() {
    pendingGalleryChange = undefined;
    view.reset();
    clearPhoto();
  }

  return { getState, getActions, startShooting, capturePhoto, cancelCountdown, showPhoto,
    clearPhoto, returnToCamera, dismissCaptureReview, downloadSelectedPhoto, deleteSelectedPhoto,
    undoDelete, reset };
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('capture-failed')), type, quality);
  });
}


export type CaptureController = ReturnType<typeof createCaptureController>;
