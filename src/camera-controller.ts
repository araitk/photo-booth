import { t } from './i18n';

export interface CameraState {
  readonly stream: MediaStream | null;
  readonly busy: boolean;
  readonly devices: readonly MediaDeviceInfo[];
  readonly cameraId: string;
  readonly preferredCameraId: string;
  readonly resolution: string;
  readonly appliedResolution: string;
  readonly status: 'OFF' | 'CONNECTING' | 'LIVE' | 'DISCONNECTED' | 'CONNECTION ERROR';
}

interface CameraOptions {
  cameraId: string;
  resolution: string;
  attachStream: (stream: MediaStream) => Promise<void>;
  canConfigure: () => boolean;
  changed: () => void;
  devicesChanged: () => void;
  reset: () => void;
  notice: (text: string) => void;
  error: (text: string) => void;
}

export function createCameraController(options: CameraOptions) {
  let stream: MediaStream | null = null;
  let busy = false;
  let devices: MediaDeviceInfo[] = [];
  let cameraId = options.cameraId;
  let preferredCameraId = options.cameraId;
  let resolution = options.resolution;
  let appliedResolution = resolution;
  let status: CameraState['status'] = 'OFF';
  let cameraChangePending: string | null = null;
  let resolutionChangePending = false;
  let applyingResolution = false;
  let requestVersion = 0;
  let deviceListVersion = 0;
  let pendingScheduled = false;

  function getState(): CameraState {
    return { stream, busy, devices: [...devices], cameraId, preferredCameraId, resolution, appliedResolution, status };
  }

  function changed() {
    options.changed();
    schedulePendingChanges();
  }

  function schedulePendingChanges() {
    if (pendingScheduled || busy || applyingResolution || !options.canConfigure()
      || (cameraChangePending === null && !resolutionChangePending)) return;
    pendingScheduled = true;
    void Promise.resolve().then(async () => {
      pendingScheduled = false;
      await applySelectedCamera();
      await applySelectedResolution();
    });
  }

  function stop() {
    requestVersion++;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    busy = false;
    status = 'OFF';
    options.reset();
    changed();
  }

  async function updateCameraList() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const version = ++deviceListVersion;
    try {
      const nextDevices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput' && device.deviceId);
      if (version !== deviceListVersion) return;
      const selected = cameraChangePending ?? (stream?.getVideoTracks()[0]?.getSettings().deviceId || preferredCameraId || cameraId);
      devices = nextDevices;
      cameraId = devices.some(device => device.deviceId === selected) ? selected : '';
      // Before permission, a browser may hide cameras; retain the preference until it can be checked.
      if (preferredCameraId && !devices.some(device => device.deviceId === preferredCameraId) && (stream || devices.some(device => device.label))) preferredCameraId = '';
      options.devicesChanged();
      changed();
    } catch {
      // Device enumeration is optional; the default camera can still be used.
    }
  }

  async function openCamera(deviceId?: string) {
    if (busy || (stream && deviceId === undefined)) return;
    const previousStream = stream;
    const requestedDevice = deviceId ?? (preferredCameraId || cameraId);
    const requestedResolution = resolution;
    const version = ++requestVersion;
    let nextStream: MediaStream | null = null;
    busy = true;
    status = 'CONNECTING';
    options.notice('');
    changed();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      try {
        nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          ...constraints(requestedResolution), ...(requestedDevice ? { deviceId: { exact: requestedDevice } } : {}),
        } });
      } catch (error) {
        if (version !== requestVersion) return;
        if (previousStream || !requestedDevice || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        preferredCameraId = '';
        cameraId = '';
        changed();
        nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints(requestedResolution) });
      }
      if (version !== requestVersion) { nextStream.getTracks().forEach(track => track.stop()); return; }
      await options.attachStream(nextStream);
      if (version !== requestVersion) { nextStream.getTracks().forEach(track => track.stop()); return; }
      stream = nextStream;
      previousStream?.getTracks().forEach(track => track.stop());
      status = 'LIVE';
      const settings = stream.getVideoTracks()[0].getSettings();
      const expectedHeight = Number(requestedResolution);
      const fallback = requestedResolution !== 'auto' && (settings.height !== expectedHeight || settings.width !== expectedHeight * 16 / 9);
      appliedResolution = fallback ? 'auto' : requestedResolution;
      resolutionChangePending = resolution !== requestedResolution;
      if (!resolutionChangePending && fallback) {
        resolution = 'auto';
        options.notice(t('カメラが対応する解像度で開始しました。'));
      }
      preferredCameraId = settings.deviceId || '';
      cameraId = cameraChangePending ?? preferredCameraId;
      changed();
      const activeStream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (stream !== activeStream) return;
        stop();
        status = 'DISCONNECTED';
        options.error(t('カメラとの接続が切れました。もう一度開始してください。'));
        changed();
        void updateCameraList();
      });
      await updateCameraList();
    } catch (error) {
      nextStream?.getTracks().forEach(track => track.stop());
      if (version !== requestVersion) return;
      if (previousStream && stream === previousStream) {
        try {
          await options.attachStream(previousStream);
          if (version !== requestVersion) return;
          cameraId = cameraChangePending ?? (previousStream.getVideoTracks()[0].getSettings().deviceId || '');
          status = 'LIVE';
          options.notice(t('カメラを切り替えられませんでした。元のカメラを使用します。'));
          return;
        } catch {
          // If the old camera is no longer available, show the usual connection error.
        }
      }
      stop();
      status = 'CONNECTION ERROR';
      options.error(!navigator.mediaDevices?.getUserMedia
        ? t('このブラウザではカメラを利用できません。対応ブラウザまたはlocalhostから開いてください。') : errorMessage(error));
    } finally {
      if (version === requestVersion) busy = false;
      changed();
    }
  }

  async function selectCamera(value: string) {
    cameraId = value;
    if (stream || busy) {
      cameraChangePending = value;
      await applySelectedCamera();
    } else preferredCameraId = value;
    changed();
  }

  async function selectResolution(value: string) {
    resolution = value;
    resolutionChangePending = Boolean(stream) || busy;
    changed();
    await applySelectedResolution();
  }

  async function applySelectedCamera() {
    if (cameraChangePending === null || busy || applyingResolution || !options.canConfigure()) return;
    const requested = cameraChangePending;
    cameraChangePending = null;
    if (stream) await openCamera(requested);
    else { preferredCameraId = requested; changed(); }
  }

  async function applySelectedResolution() {
    if (!resolutionChangePending || cameraChangePending !== null || !stream || busy || applyingResolution || !options.canConfigure()) return;
    const activeStream = stream;
    const version = requestVersion;
    const requested = resolution;
    const track = activeStream.getVideoTracks()[0];
    const previousConstraints = track.getConstraints();
    resolutionChangePending = false;
    applyingResolution = true;
    busy = true;
    options.notice('');
    changed();
    try {
      await track.applyConstraints(constraints(requested, true));
      if (stream !== activeStream || version !== requestVersion) return;
      appliedResolution = requested;
    } catch {
      if (stream !== activeStream || version !== requestVersion) return;
      try { await track.applyConstraints(previousConstraints); } catch { /* Show the actual remaining settings below. */ }
      if (stream !== activeStream || version !== requestVersion) return;
      if (resolution === requested) resolution = appliedResolution;
      options.notice(t('この解像度は利用できません。変更前の設定に戻しました。'));
    } finally {
      applyingResolution = false;
      if (stream === activeStream && version === requestVersion) busy = false;
      changed();
    }
  }

  return { getState, openCamera, stop, updateCameraList, selectCamera, selectResolution, schedulePendingChanges };
}

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

function errorMessage(error: unknown): string {
  if (!(error instanceof DOMException)) return t("カメラを開始できませんでした。もう一度お試しください。");
  switch (error.name) {
    case 'NotAllowedError': return t("カメラの使用を許可してください。ブラウザのサイト設定から変更できます。");
    case 'NotFoundError': return t("カメラが見つかりません。接続を確認してください。");
    case 'NotReadableError': return t("カメラを使用できません。他のアプリで使用中でないか確認してください。");
    case 'OverconstrainedError': return t("指定した設定を利用できません。別の解像度をお試しください。");
    default: return t("カメラを開始できませんでした。接続とブラウザの設定を確認してください。");
  }
}


export type CameraController = ReturnType<typeof createCameraController>;
