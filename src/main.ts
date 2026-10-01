import './style.css';
import { returnKeyframes } from './return-effects';

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
const photoReview = document.querySelector<HTMLButtonElement>('#photo-review')!;
const capturedPhoto = document.querySelector<HTMLImageElement>('#captured-photo')!;
const flash = document.querySelector<HTMLDivElement>('#capture-flash')!;
const galleryDestination = document.querySelector<HTMLDivElement>('.gallery-empty')!;
const captureCanvas = document.createElement('canvas');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let stream: MediaStream | null = null;
let busy = false;
let appliedResolution = resolution.value;
let previewRatio = 16 / 9;
let requestVersion = 0;
let captureVersion = 0;
let capturePhase: 'live' | 'capturing' | 'review' | 'returning' = 'live';
let photoUrl: string | null = null;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let animations: Animation[] = [];

function setBusy(value: boolean) {
  busy = value;
  startButton.disabled = value;
  resolution.disabled = value || !stream || capturePhase !== 'live';
  shutter.disabled = value || !stream || capturePhase !== 'live' || video.readyState < 2 || !video.videoWidth;
}

function clearPhoto() {
  captureVersion++;
  clearTimeout(reviewTimer);
  clearTimeout(transitionTimer);
  animations.forEach(animation => animation.cancel());
  animations = [];
  photoReview.hidden = true;
  capturedPhoto.removeAttribute('src');
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  viewfinder.classList.remove('is-review');
  capturePhase = 'live';
  setBusy(busy);
}

async function capturePhoto() {
  if (shutter.disabled || !stream) return;
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
    const blob = await new Promise<Blob>((resolve, reject) => {
      captureCanvas.toBlob(value => value ? resolve(value) : reject(new Error('capture-failed')), 'image/png');
    });
    if (version !== captureVersion || !stream) return;
    photoUrl = URL.createObjectURL(blob);
    capturedPhoto.src = photoUrl;
    await capturedPhoto.decode();
    if (version !== captureVersion || !stream) return;
    photoReview.hidden = false;
    viewfinder.classList.add('is-review');
    capturePhase = 'review';
    setCameraStatus('PHOTO');
    setBusy(busy);
    reviewTimer = setTimeout(() => { void returnToCamera(); }, 3000);
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
  clearTimeout(reviewTimer);
  const version = captureVersion;
  if (reducedMotion.matches) {
    clearPhoto();
    if (stream) setCameraStatus('LIVE', true);
    return;
  }
  const duration = 1000;
  try {
    const animation = photoReview.animate(
      returnKeyframes(photoReview.getBoundingClientRect(), galleryDestination.getBoundingClientRect()),
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
  if (stream) setCameraStatus('LIVE', true);
}

shutter.addEventListener('click', () => { void capturePhoto(); });
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
    startButton.innerHTML = 'カメラを開始 <span aria-hidden="true">↗</span>';
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
window.addEventListener('pagehide', resetCamera);

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
