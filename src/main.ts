import { returnKeyframes } from './return-effects';
import { PhotoStore, photoFilename, type Photo } from './photo-store';

const video = document.querySelector<HTMLVideoElement>('#camera')!;
const viewfinder = document.querySelector<HTMLDivElement>('#viewfinder')!;
const previewSpace = document.querySelector<HTMLDivElement>('#preview-space')!;
const mediaSurface = document.querySelector<HTMLDivElement>('#media-surface')!;
const placeholder = document.querySelector<HTMLDivElement>('#placeholder')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-camera')!;
const resolution = document.querySelector<HTMLSelectElement>('#resolution')!;
const cameraSelect = document.querySelector<HTMLSelectElement>('#camera-select')!;
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreen')!;
const actualSettings = document.querySelector<HTMLSpanElement>('#actual-settings')!;
const liveBadge = document.querySelector<HTMLSpanElement>('#live-badge')!;
const message = document.querySelector<HTMLParagraphElement>('#camera-message')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const shutter = document.querySelector<HTMLButtonElement>('#shutter')!;
const timer = document.querySelector<HTMLSelectElement>('#timer')!;
const countdown = document.querySelector<HTMLDivElement>('#countdown')!;
const photoReview = document.querySelector<HTMLButtonElement>('#photo-review')!;
let capturedPhoto = document.querySelector<HTMLImageElement>('#captured-photo')!;
const flash = document.querySelector<HTMLDivElement>('#capture-flash')!;
const galleryEmpty = document.querySelector<HTMLDivElement>('.gallery-empty')!;
const galleryList = document.querySelector<HTMLDivElement>('#gallery-list')!;
const newThumbnailTarget = document.querySelector<HTMLSpanElement>('#new-thumbnail-target')!;
const photoCount = document.querySelector<HTMLSpanElement>('#photo-count')!;
const photoPosition = document.querySelector<HTMLSpanElement>('#photo-position')!;
const photoActions = document.querySelector<HTMLDivElement>('#photo-actions')!;
const previewControls = document.querySelector<HTMLDivElement>('.preview-controls')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download-photo')!;
const deleteButton = document.querySelector<HTMLButtonElement>('#delete-photo')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo-delete')!;
const shortcutHelp = document.querySelector<HTMLDialogElement>('#shortcut-help')!;
const shortcutHelpButton = document.querySelector<HTMLButtonElement>('#show-shortcuts')!;
const closeShortcutHelp = document.querySelector<HTMLButtonElement>('#close-shortcuts')!;
const photos = new PhotoStore();
const thumbnailImages = new Map<number, HTMLImageElement>();
const downloads = new Map<string, { photoId: number; timer: ReturnType<typeof setTimeout> }>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const settingsStorageKey = 'photo-booth.settings.v1';
let preferredCameraId = '';

function restoreSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
    if (!settings || typeof settings !== 'object') return;
    if (['0', '3', '5', '10'].includes(settings.timer)) timer.value = settings.timer;
    if (['auto', '720', '1080', '2160'].includes(settings.resolution)) resolution.value = settings.resolution;
    if (typeof settings.cameraId === 'string') preferredCameraId = settings.cameraId;
  } catch {
    // Keep the defaults if storage is unavailable or the saved data is invalid.
  }
}

function saveSettings() {
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify({ timer: timer.value, resolution: resolution.value, cameraId: preferredCameraId }));
  } catch {
    // Camera controls remain usable when the browser blocks storage.
  }
}

restoreSettings();

let stream: MediaStream | null = null;
let cameraDeviceCount = 0;
let cameraChangePending: string | null = null;
let deviceListVersion = 0;
let busy = false;
let appliedResolution = resolution.value;
let resolutionChangePending = false;
let applyingResolution = false;
let previewRatio = 16 / 9;
let requestVersion = 0;
let captureVersion = 0;
let capturePhase: 'live' | 'countdown' | 'capturing' | 'review' | 'returning' = 'live';
let countdownTimer: ReturnType<typeof setTimeout> | undefined;
let photoUrl: string | null = null;
let selectedPhotoId: number | null = null;
let pendingPhotoId: number | null = null;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let animations: Animation[] = [];
const returningPhotos = new Map<HTMLDivElement, { url: string; animation: Animation | null }>();
let unloadWarningActive = false;

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

function releaseReturningPhoto(element: HTMLDivElement) {
  const entry = returningPhotos.get(element);
  if (!entry) return;
  element.replaceChildren();
  element.remove();
  URL.revokeObjectURL(entry.url);
  returningPhotos.delete(element);
}

function setBusy(value: boolean) {
  busy = value;
  viewfinder.classList.toggle('is-returning', capturePhase === 'returning');
  previewControls.hidden = !stream;
  startButton.disabled = value;
  resolution.disabled = false;
  cameraSelect.disabled = cameraDeviceCount === 0;
  timer.disabled = false;
  shutter.disabled = value || !stream || !['live', 'countdown', 'returning'].includes(capturePhase) || video.readyState < 2 || !video.videoWidth;
  const counting = capturePhase === 'countdown';
  shutter.classList.toggle('is-counting', counting);
  shutter.setAttribute('aria-label', counting ? '撮影をキャンセル' : '撮影');
  shutter.title = counting ? '撮影をキャンセル (Space / Esc)' : '撮影 (Space)';
  const locked = value || counting || capturePhase === 'capturing' || capturePhase === 'returning';
  downloadButton.disabled = locked;
  deleteButton.disabled = locked;
  undoButton.disabled = locked || !photos.canUndo;
  const reviewing = !photoReview.hidden && capturePhase !== 'returning';
  photoActions.hidden = !reviewing;
  downloadButton.hidden = !reviewing;
  deleteButton.hidden = !reviewing;
  undoButton.hidden = !photos.canUndo;
  const galleryLocked = value || counting || capturePhase === 'capturing' || (pendingPhotoId !== null && capturePhase !== 'returning');
  galleryList.querySelectorAll<HTMLButtonElement>('.thumbnail').forEach(button => { button.disabled = galleryLocked; });
  if (!value && (cameraChangePending !== null || resolutionChangePending)) {
    void Promise.resolve().then(async () => {
      await applySelectedCamera();
      await applySelectedResolution();
    });
  }
}

function thumbnailImage(photo: Photo) {
  let image = thumbnailImages.get(photo.id);
  if (!image) {
    image = document.createElement('img');
    image.src = photo.thumbnailUrl;
    image.alt = `写真 ${photo.id}`;
    image.width = Math.min(240, photo.width);
    image.height = Math.round(image.width * photo.height / photo.width);
    thumbnailImages.set(photo.id, image);
  }
  return image;
}

function renderGallery() {
  syncUnloadWarning();
  const allPhotos = photos.list();
  const selectedIndex = allPhotos.findIndex(photo => photo.id === selectedPhotoId);
  photoPosition.hidden = selectedIndex < 0;
  photoCount.hidden = selectedIndex >= 0;
  photoPosition.textContent = selectedIndex >= 0 ? `${allPhotos.length - selectedIndex} / ${allPhotos.length}` : '';
  if (selectedIndex >= 0) photoPosition.setAttribute('aria-label', `${allPhotos.length}枚中${allPhotos.length - selectedIndex}枚目`);
  else photoPosition.removeAttribute('aria-label');
  for (const id of thumbnailImages.keys()) {
    if (!photos.get(id)) thumbnailImages.delete(id);
  }
  const scroll = galleryList.scrollLeft;
  galleryList.replaceChildren();
  const list = allPhotos.filter(photo => photo.id !== pendingPhotoId);
  photoCount.textContent = String(allPhotos.length);
  galleryEmpty.hidden = list.length > 0;
  galleryList.hidden = list.length === 0;
  let selectedThumbnail: HTMLButtonElement | undefined;
  for (const photo of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail';
    button.dataset.photoId = String(photo.id);
    button.setAttribute('aria-label', `写真 ${photo.id} を表示`);
    button.setAttribute('aria-pressed', String(photo.id === selectedPhotoId));
    button.disabled = busy || (pendingPhotoId !== null && capturePhase !== 'returning') || capturePhase === 'countdown' || capturePhase === 'capturing';
    button.append(thumbnailImage(photo));
    button.addEventListener('click', () => {
      if (photo.id === selectedPhotoId) {
        void returnToCamera();
      } else {
        void showPhoto(photo);
      }
    });
    galleryList.append(button);
    if (photo.id === selectedPhotoId) selectedThumbnail = button;
  }
  galleryList.scrollLeft = scroll;
  selectedThumbnail?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

function cancelPhotoAnimations() {
  animations.forEach(animation => animation.cancel());
  animations = [];
}

function clearPhoto(pendingId: number | null = null) {
  cancelCountdown();
  captureVersion++;
  clearTimeout(reviewTimer);
  cancelPhotoAnimations();
  photoReview.hidden = true;
  capturedPhoto.removeAttribute('src');
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  selectedPhotoId = null;
  pendingPhotoId = pendingId;
  viewfinder.classList.remove('is-review');
  placeholder.hidden = Boolean(stream);
  capturePhase = 'live';
  previewRatio = video.videoWidth && stream ? video.videoWidth / video.videoHeight : 16 / 9;
  fitPreview();
  renderGallery();
  setBusy(busy);
}

async function showPhoto(photo: Photo, automatic = false): Promise<boolean> {
  if (!photos.get(photo.id)) return false;
  const switching = !photoReview.hidden;
  if (!switching) clearPhoto(automatic ? photo.id : null);
  clearTimeout(reviewTimer);
  const version = ++captureVersion;
  capturePhase = 'capturing';
  setBusy(busy);
  let nextUrl: string | null = null;
  try {
    nextUrl = URL.createObjectURL(photo.original);
    const nextImage = document.createElement('img');
    nextImage.id = 'captured-photo';
    nextImage.alt = '撮影した写真';
    nextImage.src = nextUrl;
    await Promise.all([
      nextImage.decode(),
      thumbnailImage(photo).decode().catch(() => {}),
    ]);
    if (version !== captureVersion) return false;
    cancelPhotoAnimations();
    const previousImage = capturedPhoto;
    const previousUrl = photoUrl;
    photoReview.replaceChildren(nextImage);
    capturedPhoto = nextImage;
    photoUrl = nextUrl;
    nextUrl = null;
    previousImage.removeAttribute('src');
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    selectedPhotoId = photo.id;
    pendingPhotoId = automatic ? photo.id : null;
    previewRatio = photo.width / photo.height;
    fitPreview();
    photoReview.hidden = false;
    placeholder.hidden = true;
    viewfinder.classList.add('is-review');
    capturePhase = 'review';
    setCameraStatus('PHOTO');
    actualSettings.hidden = false;
    actualSettings.textContent = `${photo.width} × ${photo.height}`;
    renderGallery();
    if (automatic) galleryList.scrollLeft = 0;
    setBusy(busy);
    if (automatic) reviewTimer = setTimeout(() => { void returnToCamera(); }, 3000);
    return true;
  } catch {
    if (version === captureVersion) {
      if (switching) {
        cancelPhotoAnimations();
        capturePhase = 'review';
        setBusy(busy);
      } else {
        clearPhoto();
        setCameraStatus(stream ? 'LIVE' : 'OFF', Boolean(stream));
        updateSettings();
      }
      status.textContent = '写真を表示できませんでした。';
    }
    return false;
  } finally {
    if (nextUrl) URL.revokeObjectURL(nextUrl);
  }
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('capture-failed')), type, quality);
  });
}

function cancelCountdown() {
  clearTimeout(countdownTimer);
  countdownTimer = undefined;
  countdown.hidden = true;
  countdown.textContent = '';
  if (capturePhase === 'countdown') {
    capturePhase = 'live';
    setBusy(busy);
  }
}

function startShooting() {
  if (capturePhase === 'countdown') {
    cancelCountdown();
    return;
  }
  if (shutter.disabled || (capturePhase !== 'live' && capturePhase !== 'returning') || !stream) return;
  const seconds = Number(timer.value);
  if (![3, 5, 10].includes(seconds)) {
    void capturePhoto();
    return;
  }
  if (capturePhase === 'returning') clearPhoto();
  capturePhase = 'countdown';
  status.textContent = '';
  setBusy(busy);
  const deadline = Date.now() + seconds * 1000;
  const tick = () => {
    if (capturePhase !== 'countdown') return;
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      cancelCountdown();
      void capturePhoto();
      return;
    }
    const secondsLeft = Math.ceil(remaining / 1000);
    countdown.hidden = false;
    countdown.textContent = String(secondsLeft);
    countdownTimer = setTimeout(tick, remaining - (secondsLeft - 1) * 1000);
  };
  tick();
}

async function capturePhoto() {
  if (shutter.disabled || (capturePhase !== 'live' && capturePhase !== 'returning') || !stream) return;
  const captureCanvas = document.createElement('canvas');
  capturePhase = 'capturing';
  setBusy(busy);
  const version = ++captureVersion;
  status.textContent = '';
  const context = captureCanvas.getContext('2d');
  if (!context) {
    clearPhoto();
    status.textContent = '撮影できませんでした。もう一度お試しください。';
    return;
  }
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  try {
    // Draw the source frame directly: CSS mirroring and UI overlays are excluded.
    context.drawImage(video, 0, 0);
    if (!reducedMotion.matches) {
      const animation = flash.animate([{ opacity: 0.75 }, { opacity: 0 }], { duration: 180 });
      animations.push(animation);
    }
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
      encodeCanvas(thumbnailCanvas, 'image/jpeg', 0.8).finally(() => {
        thumbnailCanvas.width = 0;
        thumbnailCanvas.height = 0;
      }),
    ]);
    if (version !== captureVersion || !stream) return;
    const photo = photos.add(blob, thumbnail, width, height);
    syncUnloadWarning();
    if (!await showPhoto(photo, true)) {
      photos.remove(photo.id);
      renderGallery();
    }
  } catch {
    if (version === captureVersion) {
      clearPhoto();
      status.textContent = '撮影できませんでした。もう一度お試しください。';
    }
  } finally {
    captureCanvas.width = 0;
    captureCanvas.height = 0;
  }
}

async function returnToCamera() {
  if (capturePhase !== 'review') return;
  capturePhase = 'returning';
  restoreCameraStatus();
  setBusy(busy);
  clearTimeout(reviewTimer);
  const destination = pendingPhotoId === selectedPhotoId
    ? newThumbnailTarget
    : galleryList.querySelector<HTMLButtonElement>(`[data-photo-id="${selectedPhotoId}"]`) || newThumbnailTarget;
  const destinationRect = destination.getBoundingClientRect();
  selectedPhotoId = null;
  renderGallery();
  setBusy(busy);
  const version = captureVersion;
  if (reducedMotion.matches) {
    clearPhoto();
    restoreCameraStatus();
    return;
  }
  // Keep the departing image independent of the next capture and preview.
  const returningPhoto = document.createElement('div');
  returningPhoto.className = 'photo-review returning-photo';
  returningPhoto.setAttribute('aria-hidden', 'true');
  // Keep older departures in front of a new full-size departing image.
  for (const element of returningPhotos.keys()) {
    element.style.zIndex = String(Number(element.style.zIndex) + 1);
  }
  returningPhoto.style.zIndex = '2';
  capturedPhoto.removeAttribute('id');
  returningPhoto.append(capturedPhoto);
  mediaSurface.append(returningPhoto);
  returningPhotos.set(returningPhoto, { url: photoUrl!, animation: null });
  photoUrl = null;
  capturedPhoto = document.createElement('img');
  capturedPhoto.id = 'captured-photo';
  capturedPhoto.alt = '撮影した写真';
  photoReview.replaceChildren(capturedPhoto);
  photoReview.hidden = true;
  const duration = 1000;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const animation = returningPhoto.animate(
      returnKeyframes(returningPhoto.getBoundingClientRect(), destinationRect),
      { duration, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' },
    );
    returningPhotos.get(returningPhoto)!.animation = animation;
    // Some browser views suspend their animation timeline while still running timers.
    await Promise.race([
      animation.finished,
      new Promise<void>(resolve => { returnTimer = setTimeout(resolve, duration + 120); }),
    ]);
  } catch {
    // Cancelling an animation during camera disconnect is expected.
  } finally {
    clearTimeout(returnTimer);
    releaseReturningPhoto(returningPhoto);
  }
  if (version !== captureVersion) return;
  clearPhoto();
  restoreCameraStatus();
}

function restoreCameraStatus() {
  setCameraStatus(stream ? 'LIVE' : 'OFF', Boolean(stream));
  actualSettings.hidden = !stream;
  updateSettings();
}

function releaseDownload(url: string) {
  const download = downloads.get(url);
  if (!download) return;
  clearTimeout(download.timer);
  URL.revokeObjectURL(url);
  downloads.delete(url);
}

function downloadSelectedPhoto() {
  const photo = selectedPhotoId === null ? undefined : photos.get(selectedPhotoId);
  if (!photo || downloadButton.disabled) return;
  const url = URL.createObjectURL(photo.original);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = photoFilename(photo);
  document.body.append(anchor);
  anchor.click();
  photos.markDownloaded(photo.id);
  syncUnloadWarning();
  anchor.remove();
  downloads.set(url, { photoId: photo.id, timer: setTimeout(() => releaseDownload(url), 60000) });
}

async function deleteSelectedPhoto() {
  if (selectedPhotoId === null || deleteButton.disabled) return;
  const id = selectedPhotoId;
  const list = photos.list();
  const index = list.findIndex(photo => photo.id === id);
  const next = list[index - 1] || list[index + 1];
  photos.removeUndoable(id);
  for (const [url, download] of downloads) {
    if (download.photoId === id) releaseDownload(url);
  }
  if (next) {
    const shown = await showPhoto(next);
    if (!shown && selectedPhotoId === id) {
      clearPhoto();
      restoreCameraStatus();
    }
  } else {
    clearPhoto();
    restoreCameraStatus();
  }
}

downloadButton.addEventListener('click', downloadSelectedPhoto);
deleteButton.addEventListener('click', deleteSelectedPhoto);
async function undoDelete() {
  if (undoButton.disabled) return;
  const photo = photos.undoRemove();
  if (!photo) return;
  renderGallery();
  await showPhoto(photo);
}
undoButton.addEventListener('click', () => { void undoDelete(); });

shutter.addEventListener('click', startShooting);
shortcutHelpButton.addEventListener('click', () => { if (!shortcutHelp.open) shortcutHelp.showModal(); });
closeShortcutHelp.addEventListener('click', () => { shortcutHelp.close(); });
document.addEventListener('keydown', event => {
  const arrowKey = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  if ((event.repeat && !arrowKey) || event.isComposing || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z' && !event.shiftKey && !shortcutHelp.open && !undoButton.disabled && photos.canUndo) {
      event.preventDefault();
      void undoDelete();
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
    shortcutHelp.showModal();
    return;
  }
  if (event.key === 'Enter') {
    if (!target?.closest?.('button, a') && !stream && !busy) {
      event.preventDefault();
      void openCamera();
    }
    return;
  }
  if (event.key === 'Escape') {
    if (capturePhase === 'countdown') {
      event.preventDefault();
      cancelCountdown();
    } else if (capturePhase === 'review' && !document.fullscreenElement) {
      event.preventDefault();
      void returnToCamera();
    }
    return;
  }
  if (event.key === ' ') {
    if (!busy && capturePhase === 'review') {
      event.preventDefault();
      void returnToCamera();
      return;
    }
    if (target?.closest?.('button, a')) return;
    if (!shutter.disabled) {
      event.preventDefault();
      startShooting();
    }
    return;
  }
  if (event.key.toLowerCase() === 'f' && !fullscreenButton.disabled) {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (busy) return;
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
    if (next) void showPhoto(next);
    return;
  }
  if (capturePhase !== 'review' || selectedPhotoId === null) return;
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    downloadSelectedPhoto();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedPhoto();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelCountdown();
});
photoReview.addEventListener('click', () => { void returnToCamera(); });
video.addEventListener('loadeddata', () => { setBusy(busy); });

function setCameraStatus(label: string, live = false) {
  liveBadge.replaceChildren();
  const dot = document.createElement('span');
  dot.setAttribute('aria-hidden', 'true');
  liveBadge.append(dot, document.createTextNode(` ${label}`));
  liveBadge.classList.toggle('is-live', live);
}

function fitPreview() {
  if (document.fullscreenElement !== viewfinder) {
    const width = Math.min(previewSpace.clientWidth, previewSpace.clientHeight * 16 / 9);
    viewfinder.style.width = `${width}px`;
    viewfinder.style.height = `${width * 9 / 16}px`;
  }
  const width = Math.min(viewfinder.clientWidth, viewfinder.clientHeight * previewRatio);
  mediaSurface.style.width = `${width}px`;
  mediaSurface.style.height = `${width / previewRatio}px`;
}

const previewObserver = new ResizeObserver(fitPreview);
previewObserver.observe(previewSpace);
previewObserver.observe(viewfinder);

function constraints(value: string, strict = false): MediaTrackConstraints {
  if (value === 'auto') return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  const height = Number(value);
  const width = height * 16 / 9;
  return {
    width: strict ? { exact: width } : { ideal: width },
    height: strict ? { exact: height } : { ideal: height },
    frameRate: { ideal: 30 },
  };
}

function updateSettings() {
  if (!stream) return;
  if (capturePhase === 'review') return;
  const settings = stream.getVideoTracks()[0].getSettings();
  const width = video.videoWidth || settings.width;
  const height = video.videoHeight || settings.height;
  actualSettings.textContent = width && height
    ? `${width} × ${height}${settings.frameRate ? ` / ${Math.round(settings.frameRate)} fps` : ''}`
    : 'CONNECTING';
  actualSettings.hidden = false;
  if (width && height) {
    previewRatio = width / height;
    fitPreview();
  }
}

function resetCamera() {
  requestVersion++;
  for (const [element, entry] of returningPhotos) {
    entry.animation?.cancel();
    releaseReturningPhoto(element);
  }
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  clearPhoto();
  video.srcObject = null;
  viewfinder.classList.remove('is-live');
  previewRatio = 16 / 9;
  fitPreview();
  placeholder.hidden = false;
  setCameraStatus('OFF');
  actualSettings.textContent = '';
  actualSettings.hidden = true;
  setBusy(false);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof DOMException)) return 'カメラを開始できませんでした。もう一度お試しください。';
  switch (error.name) {
    case 'NotAllowedError': return 'カメラの使用を許可してください。ブラウザのサイト設定から変更できます。';
    case 'NotFoundError': return 'カメラが見つかりません。接続を確認してください。';
    case 'NotReadableError': return 'カメラを使用できません。他のアプリで使用中でないか確認してください。';
    case 'OverconstrainedError': return '指定した設定を利用できません。別の解像度をお試しください。';
    default: return 'カメラを開始できませんでした。接続とブラウザの設定を確認してください。';
  }
}

async function updateCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const version = ++deviceListVersion;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput' && device.deviceId);
    if (version !== deviceListVersion) return;
    const selected = cameraChangePending ?? (stream?.getVideoTracks()[0]?.getSettings().deviceId || preferredCameraId || cameraSelect.value);
    cameraSelect.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '自動';
    cameraSelect.append(automatic);
    devices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `カメラ ${index + 1}`;
      cameraSelect.append(option);
    });
    cameraDeviceCount = devices.length;
    cameraSelect.value = devices.some(device => device.deviceId === selected) ? selected : '';
    // Before permission, a browser may hide cameras; retain the preference until it can be checked.
    if (preferredCameraId && !devices.some(device => device.deviceId === preferredCameraId) && (stream || devices.some(device => device.label))) {
      preferredCameraId = '';
      saveSettings();
    }
    setBusy(busy);
  } catch {
    // Device enumeration is optional; the default camera can still be used.
  }
}

async function openCamera(deviceId?: string) {
  if (busy || (stream && deviceId === undefined)) return;
  const previousStream = stream;
  const requestedDevice = deviceId ?? (preferredCameraId || cameraSelect.value);
  const requestedResolution = resolution.value;
  const version = ++requestVersion;
  let nextStream: MediaStream | null = null;
  setBusy(true);
  startButton.textContent = '接続中…';
  setCameraStatus('CONNECTING');
  status.textContent = '';
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('unsupported');
    }
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...constraints(requestedResolution),
        ...(requestedDevice ? { deviceId: { exact: requestedDevice } } : {}),
      } });
    } catch (error) {
      if (version !== requestVersion) return;
      if (previousStream || !requestedDevice || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
      preferredCameraId = '';
      cameraSelect.value = '';
      saveSettings();
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints(requestedResolution) });
    }
    if (version !== requestVersion) {
      nextStream.getTracks().forEach(track => track.stop());
      return;
    }
    video.srcObject = nextStream;
    await video.play();
    if (version !== requestVersion) {
      nextStream.getTracks().forEach(track => track.stop());
      return;
    }
    stream = nextStream;
    previousStream?.getTracks().forEach(track => track.stop());
    placeholder.hidden = true;
    viewfinder.classList.add('is-live');
    setCameraStatus(capturePhase === 'review' ? 'PHOTO' : 'LIVE', capturePhase !== 'review');
    updateSettings();
    const settings = stream.getVideoTracks()[0].getSettings();
    const expectedHeight = Number(requestedResolution);
    const fallback = requestedResolution !== 'auto' && (settings.height !== expectedHeight || settings.width !== expectedHeight * 16 / 9);
    appliedResolution = fallback ? 'auto' : requestedResolution;
    resolutionChangePending = resolution.value !== requestedResolution;
    if (!resolutionChangePending && fallback) {
      resolution.value = 'auto';
      status.textContent = 'カメラが対応する解像度で開始しました。';
    }
    preferredCameraId = settings.deviceId || '';
    saveSettings();
    const activeStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (stream !== activeStream) return;
      resetCamera();
      setCameraStatus('DISCONNECTED');
      message.textContent = 'カメラとの接続が切れました。もう一度開始してください。';
      void updateCameraList();
    });
    await updateCameraList();
  } catch (error) {
    nextStream?.getTracks().forEach(track => track.stop());
    if (version !== requestVersion) return;
    if (previousStream && stream === previousStream) {
      video.srcObject = previousStream;
      try {
        await video.play();
        if (version !== requestVersion) return;
        cameraSelect.value = cameraChangePending ?? (previousStream.getVideoTracks()[0].getSettings().deviceId || '');
        setCameraStatus(capturePhase === 'review' ? 'PHOTO' : 'LIVE', capturePhase !== 'review');
        status.textContent = 'カメラを切り替えられませんでした。元のカメラを使用します。';
        return;
      } catch {
        // If the old camera is no longer available, show the usual connection error.
      }
    }
    resetCamera();
    setCameraStatus('CONNECTION ERROR');
    message.textContent = !navigator.mediaDevices?.getUserMedia
      ? 'このブラウザではカメラを利用できません。対応ブラウザまたはlocalhostから開いてください。'
      : errorMessage(error);
  } finally {
    startButton.textContent = 'カメラを開始';
    if (version === requestVersion) setBusy(false);
  }
}

startButton.addEventListener('click', () => { void openCamera(); });
cameraSelect.addEventListener('change', async () => {
  if (stream || busy) {
    cameraChangePending = cameraSelect.value;
    await applySelectedCamera();
  }
  else {
    preferredCameraId = cameraSelect.value;
    saveSettings();
  }
});
navigator.mediaDevices?.addEventListener('devicechange', () => { void updateCameraList(); });
void updateCameraList();
timer.addEventListener('change', saveSettings);

async function applySelectedCamera() {
  if (cameraChangePending === null || busy || applyingResolution || !['live', 'review'].includes(capturePhase)) return;
  const requested = cameraChangePending;
  cameraChangePending = null;
  if (stream) await openCamera(requested);
  else {
    preferredCameraId = requested;
    saveSettings();
  }
}

async function applySelectedResolution() {
  if (!resolutionChangePending || cameraChangePending !== null || !stream || busy || applyingResolution || !['live', 'review'].includes(capturePhase)) return;
  const activeStream = stream;
  const version = requestVersion;
  const requested = resolution.value;
  const track = activeStream.getVideoTracks()[0];
  const previousConstraints = track.getConstraints();
  resolutionChangePending = false;
  applyingResolution = true;
  setBusy(true);
  status.textContent = '';
  try {
    await track.applyConstraints(constraints(requested, true));
    if (stream !== activeStream || version !== requestVersion) return;
    appliedResolution = requested;
    updateSettings();
  } catch {
    if (stream !== activeStream || version !== requestVersion) return;
    try { await track.applyConstraints(previousConstraints); } catch { /* Show the actual remaining settings below. */ }
    if (stream !== activeStream || version !== requestVersion) return;
    if (resolution.value === requested) resolution.value = appliedResolution;
    status.textContent = 'この解像度は利用できません。変更前の設定に戻しました。';
    updateSettings();
  } finally {
    applyingResolution = false;
    saveSettings();
    if (stream === activeStream && version === requestVersion) setBusy(false);
    else if (cameraChangePending !== null || resolutionChangePending) setBusy(busy);
  }
}
resolution.addEventListener('change', async () => {
  resolutionChangePending = Boolean(stream) || busy;
  saveSettings();
  await applySelectedResolution();
});

video.addEventListener('resize', () => { updateSettings(); setBusy(busy); });
window.addEventListener('pagehide', event => {
  resetCamera();
  if (!event.persisted) {
    photos.clear();
    syncUnloadWarning();
    thumbnailImages.clear();
    for (const url of downloads.keys()) releaseDownload(url);
  }
});

function updateFullscreen() {
  const active = document.fullscreenElement === viewfinder;
  const label = active ? 'フルスクリーンを終了' : 'フルスクリーン';
  fullscreenButton.setAttribute('aria-label', label);
  fullscreenButton.setAttribute('aria-pressed', String(active));
  fullscreenButton.title = `${label} (F)`;
  fitPreview();
}

fullscreenButton.disabled = !document.fullscreenEnabled || !viewfinder.requestFullscreen;
if (fullscreenButton.disabled) fullscreenButton.title = 'このブラウザではフルスクリーンを利用できません';
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewfinder.requestFullscreen();
  } catch {
    status.textContent = 'フルスクリーンに切り替えられませんでした。ブラウザの設定を確認してください。';
  }
  updateFullscreen();
}
fullscreenButton.addEventListener('click', () => { void toggleFullscreen(); });
document.addEventListener('fullscreenchange', updateFullscreen);
