import './style.css';

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

let stream: MediaStream | null = null;
let busy = false;
let appliedResolution = resolution.value;
let previewRatio = 16 / 9;
let requestVersion = 0;

function setBusy(value: boolean) {
  busy = value;
  startButton.disabled = value;
  resolution.disabled = value || !stream;
}

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

video.addEventListener('resize', updateSettings);
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
