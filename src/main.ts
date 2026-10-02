import { returnKeyframes } from './return-effects';
import { PhotoStore, photoFilename, type Photo } from './photo-store';

const video = document.querySelector<HTMLVideoElement>('#camera')!;
const viewfinder = document.querySelector<HTMLDivElement>('#viewfinder')!;
const previewSpace = document.querySelector<HTMLDivElement>('#preview-space')!;
const mediaSurface = document.querySelector<HTMLDivElement>('#media-surface')!;
const placeholder = document.querySelector<HTMLDivElement>('#placeholder')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-camera')!;
const resolution = document.querySelector<HTMLSelectElement>('#resolution')!;
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreen')!;
const actualSettings = document.querySelector<HTMLSpanElement>('#actual-settings')!;
const liveBadge = document.querySelector<HTMLSpanElement>('#live-badge')!;
const message = document.querySelector<HTMLParagraphElement>('#camera-message')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const shutter = document.querySelector<HTMLButtonElement>('#shutter')!;
const timer = document.querySelector<HTMLSelectElement>('#timer')!;
const countdown = document.querySelector<HTMLDivElement>('#countdown')!;
const photoReview = document.querySelector<HTMLButtonElement>('#photo-review')!;
const capturedPhoto = document.querySelector<HTMLImageElement>('#captured-photo')!;
const flash = document.querySelector<HTMLDivElement>('#capture-flash')!;
const galleryEmpty = document.querySelector<HTMLDivElement>('.gallery-empty')!;
const galleryList = document.querySelector<HTMLDivElement>('#gallery-list')!;
const newThumbnailTarget = document.querySelector<HTMLSpanElement>('#new-thumbnail-target')!;
const photoCount = document.querySelector<HTMLSpanElement>('#photo-count')!;
const photoActions = document.querySelector<HTMLDivElement>('#photo-actions')!;
const previewControls = document.querySelector<HTMLDivElement>('.preview-controls')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download-photo')!;
const deleteButton = document.querySelector<HTMLButtonElement>('#delete-photo')!;
const photos = new PhotoStore();
const thumbnailImages = new Map<number, HTMLImageElement>();
const downloads = new Map<string, { photoId: number; timer: ReturnType<typeof setTimeout> }>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let stream: MediaStream | null = null;
let busy = false;
let appliedResolution = resolution.value;
let previewRatio = 16 / 9;
let requestVersion = 0;
let captureVersion = 0;
let capturePhase: 'live' | 'countdown' | 'capturing' | 'review' | 'returning' = 'live';
let countdownTimer: ReturnType<typeof setTimeout> | undefined;
let photoUrl: string | null = null;
let selectedPhotoId: number | null = null;
let pendingPhotoId: number | null = null;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let animations: Animation[] = [];

function setBusy(value: boolean) {
  busy = value;
  previewControls.hidden = !stream;
  startButton.disabled = value;
  resolution.disabled = value || !stream || capturePhase !== 'live';
  timer.disabled = value || !stream || capturePhase !== 'live';
  shutter.disabled = value || !stream || (capturePhase !== 'live' && capturePhase !== 'countdown') || video.readyState < 2 || !video.videoWidth;
  const counting = capturePhase === 'countdown';
  shutter.classList.toggle('is-counting', counting);
  shutter.setAttribute('aria-label', counting ? '撮影をキャンセル' : '撮影');
  shutter.title = counting ? '撮影をキャンセル' : '撮影';
  const locked = value || counting || capturePhase === 'capturing' || capturePhase === 'returning';
  downloadButton.disabled = locked;
  deleteButton.disabled = locked;
  galleryList.querySelectorAll<HTMLButtonElement>('.thumbnail').forEach(button => { button.disabled = locked || pendingPhotoId !== null; });
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
  for (const id of thumbnailImages.keys()) {
    if (!photos.get(id)) thumbnailImages.delete(id);
  }
  const scroll = galleryList.scrollLeft;
  galleryList.replaceChildren();
  const list = photos.list().filter(photo => photo.id !== pendingPhotoId);
  photoCount.textContent = String(list.length);
  galleryEmpty.hidden = list.length > 0;
  galleryList.hidden = list.length === 0;
  for (const photo of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail';
    button.dataset.photoId = String(photo.id);
    button.setAttribute('aria-label', `写真 ${photo.id} を表示`);
    button.setAttribute('aria-pressed', String(photo.id === selectedPhotoId));
    button.disabled = busy || pendingPhotoId !== null || capturePhase === 'countdown' || capturePhase === 'capturing' || capturePhase === 'returning';
    button.append(thumbnailImage(photo));
    button.addEventListener('click', () => { void showPhoto(photo); });
    galleryList.append(button);
  }
  galleryList.scrollLeft = scroll;
}

function clearPhoto(pendingId: number | null = null) {
  cancelCountdown();
  captureVersion++;
  clearTimeout(reviewTimer);
  clearTimeout(transitionTimer);
  animations.forEach(animation => animation.cancel());
  animations = [];
  photoReview.hidden = true;
  capturedPhoto.removeAttribute('src');
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  selectedPhotoId = null;
  pendingPhotoId = pendingId;
  photoActions.hidden = true;
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
  clearPhoto(automatic ? photo.id : null);
  const version = ++captureVersion;
  selectedPhotoId = photo.id;
  pendingPhotoId = automatic ? photo.id : null;
  capturePhase = 'capturing';
  setBusy(busy);
  try {
    photoUrl = URL.createObjectURL(photo.original);
    capturedPhoto.src = photoUrl;
    await Promise.all([
      capturedPhoto.decode(),
      thumbnailImage(photo).decode().catch(() => {}),
    ]);
    if (version !== captureVersion) return false;
    previewRatio = photo.width / photo.height;
    fitPreview();
    photoReview.hidden = false;
    placeholder.hidden = true;
    photoActions.hidden = false;
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
      clearPhoto();
      setCameraStatus(stream ? 'LIVE' : 'OFF', Boolean(stream));
      updateSettings();
      status.textContent = '写真を表示できませんでした。';
    }
    return false;
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
  if (shutter.disabled || capturePhase !== 'live' || !stream) return;
  const seconds = Number(timer.value);
  if (![3, 5, 10].includes(seconds)) {
    void capturePhoto();
    return;
  }
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
  if (shutter.disabled || capturePhase !== 'live' || !stream) return;
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
  setBusy(busy);
  clearTimeout(reviewTimer);
  const destination = pendingPhotoId === selectedPhotoId
    ? newThumbnailTarget
    : galleryList.querySelector<HTMLButtonElement>(`[data-photo-id="${selectedPhotoId}"]`) || newThumbnailTarget;
  const version = captureVersion;
  if (reducedMotion.matches) {
    clearPhoto();
    restoreCameraStatus();
    return;
  }
  const duration = 1000;
  try {
    const animation = photoReview.animate(
      returnKeyframes(photoReview.getBoundingClientRect(), destination.getBoundingClientRect()),
      { duration, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' },
    );
    animations.push(animation);
    // Some browser views suspend their animation timeline while still running timers.
    await Promise.race([
      animation.finished,
      new Promise<void>(resolve => { transitionTimer = setTimeout(resolve, duration + 120); }),
    ]);
  } catch {
    // Cancelling an animation during camera disconnect is expected.
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
  anchor.remove();
  downloads.set(url, { photoId: photo.id, timer: setTimeout(() => releaseDownload(url), 60000) });
}

function deleteSelectedPhoto() {
  if (selectedPhotoId === null || deleteButton.disabled) return;
  const id = selectedPhotoId;
  clearPhoto();
  photos.remove(id);
  for (const [url, download] of downloads) {
    if (download.photoId === id) releaseDownload(url);
  }
  renderGallery();
  restoreCameraStatus();
}

downloadButton.addEventListener('click', downloadSelectedPhoto);
deleteButton.addEventListener('click', deleteSelectedPhoto);

shutter.addEventListener('click', startShooting);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') cancelCountdown();
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
  if (capturePhase === 'review' || capturePhase === 'returning') return;
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
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  clearPhoto();
  video.srcObject = null;
  viewfinder.classList.remove('is-live');
  previewRatio = 16 / 9;
  fitPreview();
  placeholder.hidden = false;
  resolution.disabled = true;
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

async function openCamera() {
  if (busy || stream) return;
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
    nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints(resolution.value) });
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
    placeholder.hidden = true;
    viewfinder.classList.add('is-live');
    setCameraStatus('LIVE', true);
    resolution.disabled = false;
    updateSettings();
    const settings = stream.getVideoTracks()[0].getSettings();
    const expectedHeight = Number(resolution.value);
    if (resolution.value !== 'auto' && (settings.height !== expectedHeight || settings.width !== expectedHeight * 16 / 9)) {
      resolution.value = 'auto';
      status.textContent = 'カメラが対応する解像度で開始しました。';
    }
    appliedResolution = resolution.value;
    const activeStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (stream !== activeStream) return;
      resetCamera();
      setCameraStatus('切断');
      message.textContent = 'カメラとの接続が切れました。もう一度開始してください。';
    });
  } catch (error) {
    nextStream?.getTracks().forEach(track => track.stop());
    if (version !== requestVersion) return;
    resetCamera();
    setCameraStatus('接続エラー');
    message.textContent = !navigator.mediaDevices?.getUserMedia
      ? 'このブラウザではカメラを利用できません。対応ブラウザまたはlocalhostから開いてください。'
      : errorMessage(error);
  } finally {
    startButton.textContent = 'カメラを開始';
    if (version === requestVersion) setBusy(false);
  }
}

startButton.addEventListener('click', () => { void openCamera(); });

resolution.addEventListener('change', async () => {
  if (!stream || busy) return;
  const track = stream.getVideoTracks()[0];
  const previousConstraints = track.getConstraints();
  setBusy(true);
  status.textContent = '';
  try {
    await track.applyConstraints(constraints(resolution.value, true));
    appliedResolution = resolution.value;
    updateSettings();
  } catch {
    try { await track.applyConstraints(previousConstraints); } catch { /* Show the actual remaining settings below. */ }
    resolution.value = appliedResolution;
    status.textContent = 'この解像度は利用できません。変更前の設定に戻しました。';
    updateSettings();
  } finally {
    setBusy(false);
  }
});

video.addEventListener('resize', () => { updateSettings(); setBusy(busy); });
window.addEventListener('pagehide', event => {
  resetCamera();
  if (!event.persisted) {
    photos.clear();
    thumbnailImages.clear();
    for (const url of downloads.keys()) releaseDownload(url);
  }
});

function updateFullscreen() {
  const active = document.fullscreenElement === viewfinder;
  const label = active ? 'フルスクリーンを終了' : 'フルスクリーン';
  fullscreenButton.setAttribute('aria-label', label);
  fullscreenButton.setAttribute('aria-pressed', String(active));
  fullscreenButton.title = label;
  fitPreview();
}

fullscreenButton.disabled = !document.fullscreenEnabled || !viewfinder.requestFullscreen;
if (fullscreenButton.disabled) fullscreenButton.title = 'このブラウザではフルスクリーンを利用できません';
fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewfinder.requestFullscreen();
  } catch {
    status.textContent = 'フルスクリーンに切り替えられませんでした。ブラウザの設定を確認してください。';
  }
  updateFullscreen();
});
document.addEventListener('fullscreenchange', updateFullscreen);
