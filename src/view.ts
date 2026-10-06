import { returnKeyframes } from './return-effects';
import { photoFilename, type Photo } from './photo-store';
import { t, type TranslationMessage } from './i18n';
import type { CameraState } from './camera-controller';
import type { CaptureState, CaptureActions } from './capture-controller';

export type GalleryChange = { kind: 'delete' | 'restore'; id: number };

export function createView(onSelect: (id: number) => void) {
  const video = document.querySelector<HTMLVideoElement>('#camera')!;
  const viewfinder = document.querySelector<HTMLDivElement>('#viewfinder')!;
  const previewSpace = document.querySelector<HTMLDivElement>('#preview-space')!;
  const mediaSurface = document.querySelector<HTMLDivElement>('#media-surface')!;
  const placeholder = document.querySelector<HTMLDivElement>('#placeholder')!;
  const startButton = document.querySelector<HTMLButtonElement>('#start-camera')!;
  const resolution = document.querySelector<HTMLSelectElement>('#resolution')!;
  const cameraSelect = document.querySelector<HTMLSelectElement>('#camera-select')!;
  const languageSelect = document.querySelector<HTMLSelectElement>('#language')!;
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
  const gallery = document.querySelector<HTMLElement>('.gallery')!;
  const newThumbnailTarget = document.querySelector<HTMLSpanElement>('#new-thumbnail-target')!;
  const photoCount = document.querySelector<HTMLSpanElement>('#photo-count')!;
  const photoPosition = document.querySelector<HTMLSpanElement>('#photo-position')!;
  const photoActions = document.querySelector<HTMLDivElement>('#photo-actions')!;
  const shootingControls = document.querySelector<HTMLDivElement>('.shooting-controls')!;
  const previewControls = document.querySelector<HTMLDivElement>('.preview-controls')!;
  const downloadButton = document.querySelector<HTMLButtonElement>('#download-photo')!;
  const deleteButton = document.querySelector<HTMLButtonElement>('#delete-photo')!;
  const undoButton = document.querySelector<HTMLButtonElement>('#undo-delete')!;
  const shortcutHelp = document.querySelector<HTMLDialogElement>('#shortcut-help')!;
  const shortcutHelpButton = document.querySelector<HTMLButtonElement>('#show-shortcuts')!;
  const closeShortcutHelp = document.querySelector<HTMLButtonElement>('#close-shortcuts')!;

  const elements = { video, viewfinder, startButton, resolution, cameraSelect, languageSelect,
    fullscreenButton, shutter, timer, photoReview, galleryList,
    downloadButton, deleteButton, undoButton, shortcutHelp, shortcutHelpButton, closeShortcutHelp };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const thumbnailImages = new Map<number, HTMLImageElement>();
  const downloads = new Map<string, { photoId: number; timer: ReturnType<typeof setTimeout> }>();
  let notice: TranslationMessage | null = null;
  let cameraMessage: TranslationMessage = { key: 'カメラの使用を許可すると映像が表示されます。' };
  let previewRatio = 16 / 9;
  let photoUrl: string | null = null;
  let animations: Animation[] = [];
  const returningPhotos = new Map<HTMLDivElement, { url: string; animation: Animation | null }>();
  let gallerySpaceAnimation: Animation | null = null;
  let gallerySpacePhotoId: number | null = null;
  const galleryAnimations = new Map<Animation, HTMLElement | null>();

  function animateGalleryElement(element: HTMLElement, frames: Keyframe[], departing = false) {
    const animation = element.animate(frames, { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' });
    galleryAnimations.set(animation, departing ? element : null);
    const release = () => {
      if (departing) element.remove();
      galleryAnimations.delete(animation);
    };
    void animation.finished.then(release, release);
  }
  function releaseReturningPhoto(element: HTMLDivElement) {
    const entry = returningPhotos.get(element);
    if (!entry) return;
    element.replaceChildren();
    element.remove();
    URL.revokeObjectURL(entry.url);
    returningPhotos.delete(element);
  }

  function thumbnailImage(photo: Photo) {
    let image = thumbnailImages.get(photo.id);
    if (!image) {
      image = document.createElement('img');
      image.src = photo.thumbnailUrl;
      image.width = Math.min(240, photo.width);
      image.height = Math.round(image.width * photo.height / photo.width);
      thumbnailImages.set(photo.id, image);
    }
    image.alt = t('写真 {number}', { number: photo.id });
    return image;
  }

  function updateDownloadBadge(button: HTMLButtonElement, photo: Photo) {
    const downloaded = Boolean(photo.downloadStarted);
    button.dataset.downloaded = String(downloaded);
    button.setAttribute('aria-label', t(downloaded ? '写真 {number} を表示（ダウンロード済み）' : '写真 {number} を表示', { number: photo.id }));
  }

  function updateThumbnailMetadata(button: HTMLButtonElement, photo: Photo, number: number) {
    updateDownloadBadge(button, photo);
    const date = photo.createdAt;
    const pad = (value: number) => String(value).padStart(2, '0');
    button.title = `#${number} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function renderGallery(allPhotos: Photo[], selectedPhotoId: number | null, pendingPhotoId: number | null, galleryLocked: boolean, change: GalleryChange | null = null) {
    const previousButtons = new Map(Array.from(galleryList.querySelectorAll<HTMLButtonElement>('.thumbnail'), button => [Number(button.dataset.photoId), button]));
    const previousRects = new Map<number, DOMRect>();
    if (change && !reducedMotion.matches) {
      for (const [id, button] of previousButtons) previousRects.set(id, button.getBoundingClientRect());
    }
    const selectedIndex = allPhotos.findIndex(photo => photo.id === selectedPhotoId);
    photoPosition.hidden = selectedIndex < 0;
    photoCount.hidden = selectedIndex >= 0;
    photoPosition.textContent = selectedIndex >= 0 ? `${allPhotos.length - selectedIndex} / ${allPhotos.length}` : '';
    if (selectedIndex >= 0) photoPosition.setAttribute('aria-label', t('{total}枚中{number}枚目', { total: allPhotos.length, number: allPhotos.length - selectedIndex }));
    else photoPosition.removeAttribute('aria-label');
    const photoIds = new Set(allPhotos.map(photo => photo.id));
    for (const id of thumbnailImages.keys()) {
      if (!photoIds.has(id)) thumbnailImages.delete(id);
    }
    const scroll = galleryList.scrollLeft;
    for (const [id, button] of previousButtons) {
      if (!photoIds.has(id) || id === pendingPhotoId) button.remove();
    }
    const list = allPhotos.filter(photo => photo.id !== pendingPhotoId);
    const hasPendingPhoto = pendingPhotoId !== null && photoIds.has(pendingPhotoId);
    galleryList.classList.toggle('has-pending-photo', hasPendingPhoto);
    if (gallerySpacePhotoId !== (hasPendingPhoto ? pendingPhotoId : null)) {
      gallerySpaceAnimation?.cancel();
      gallerySpaceAnimation = null;
      gallerySpacePhotoId = hasPendingPhoto ? pendingPhotoId : null;
      if (hasPendingPhoto && list.length > 0 && !reducedMotion.matches) {
        gallerySpaceAnimation = galleryList.animate(
          [{ paddingRight: '2px' }, { paddingRight: 'calc(var(--thumbnail-width) + var(--thumbnail-gap) + 2px)' }],
          { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
        void gallerySpaceAnimation.finished.catch(() => {});
      }
    }
    photoCount.textContent = String(allPhotos.length);
    galleryEmpty.hidden = list.length > 0 || hasPendingPhoto;
    galleryList.hidden = list.length === 0 && !hasPendingPhoto;
    let selectedThumbnail: HTMLButtonElement | undefined;
    let thumbnailIndex = 0;
    for (const [index, photo] of allPhotos.entries()) {
      if (photo.id === pendingPhotoId) continue;
      const existing = previousButtons.get(photo.id);
      const button = existing ?? document.createElement('button');
      button.type = 'button';
      button.className = 'thumbnail';
      button.dataset.photoId = String(photo.id);
      updateThumbnailMetadata(button, photo, allPhotos.length - index);
      button.setAttribute('aria-pressed', String(photo.id === selectedPhotoId));
      button.setAttribute('aria-disabled', String(galleryLocked));
      if (!existing) {
        button.append(thumbnailImage(photo));
        button.addEventListener('click', () => {
          onSelect(photo.id);
        });
      } else {
        thumbnailImage(photo);
      }
      const current = galleryList.children[thumbnailIndex];
      if (current !== button) galleryList.insertBefore(button, current ?? null);
      thumbnailIndex++;
      if (photo.id === selectedPhotoId) selectedThumbnail = button;
    }
    galleryList.scrollLeft = scroll;
    selectedThumbnail?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (change && !reducedMotion.matches) {
      for (const button of galleryList.querySelectorAll<HTMLButtonElement>('.thumbnail')) {
        const id = Number(button.dataset.photoId);
        const previous = previousRects.get(id);
        if (previous) {
          const delta = previous.left - button.getBoundingClientRect().left;
          if (delta) animateGalleryElement(button, [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }]);
        } else if (change.kind === 'restore' && id === change.id) {
          animateGalleryElement(button, [{ opacity: 0, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(1)' }]);
        }
      }
      const deleted = change.kind === 'delete' ? previousButtons.get(change.id) : undefined;
      const rect = previousRects.get(change.id);
      if (deleted && rect) {
        const departing = deleted.cloneNode(true) as HTMLButtonElement;
        departing.classList.add('gallery-departing');
        departing.setAttribute('aria-hidden', 'true');
        departing.setAttribute('aria-pressed', 'false');
        departing.tabIndex = -1;
        const origin = gallery.getBoundingClientRect();
        Object.assign(departing.style, { left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        gallery.append(departing);
        animateGalleryElement(departing, [{ opacity: 1, transform: 'scaleX(1)' }, { opacity: 0, transform: 'scaleX(0)' }], true);
      }
    }
  }

  function cancelPhotoAnimations() {
    animations.forEach(animation => animation.cancel());
    animations = [];
  }

  function renderControls(camera: CameraState, capture: CaptureState, actions: CaptureActions, canUndo: boolean, hasPhotos: boolean) {
    viewfinder.classList.toggle('is-returning', capture.capturePhase === 'returning');
    viewfinder.classList.toggle('is-capture-return', capture.captureReturnInProgress);
    viewfinder.classList.toggle('has-photo-controls', hasPhotos || canUndo);
    previewControls.hidden = !camera.stream && !hasPhotos && !canUndo;
    shutter.hidden = !camera.stream;
    startButton.disabled = camera.busy;
    cameraSelect.disabled = camera.devices.length === 0;
    shutter.disabled = !actions.canShoot;
    const counting = capture.capturePhase === 'countdown';
    shutter.classList.toggle('is-counting', counting);
    shutter.setAttribute('aria-label', counting ? t('撮影をキャンセル') : t('撮影'));
    shutter.title = counting ? t('撮影をキャンセル (Space / Esc)') : t('撮影 (Space)');
    downloadButton.disabled = !actions.canDownload;
    deleteButton.disabled = !actions.canDelete;
    undoButton.disabled = !actions.canUndo;
    const reviewing = capture.selectedPhotoId !== null && capture.capturePhase !== 'returning';
    shootingControls.hidden = !camera.stream && !reviewing;
    photoActions.hidden = !reviewing;
    downloadButton.hidden = !reviewing;
    deleteButton.hidden = !reviewing;
    undoButton.hidden = !canUndo;
    // Keep keyboard focus while loading; the selection handler guards locked actions.
    galleryList.querySelectorAll<HTMLButtonElement>('.thumbnail').forEach(button => { button.setAttribute('aria-disabled', String(actions.galleryLocked)); });
  }

  function renderCamera(camera: CameraState, capture: CaptureState) {
    startButton.textContent = camera.status === 'CONNECTING' ? t('接続中…') : t('カメラを開始');
    resolution.value = camera.resolution;
    cameraSelect.value = camera.cameraId;
    viewfinder.classList.toggle('is-live', Boolean(camera.stream));
    const reviewing = capture.capturePhase === 'review' || capture.captureReturnInProgress
      || (capture.capturePhase === 'capturing' && capture.selectedPhotoId !== null);
    setCameraStatus(camera.status === 'CONNECTING' ? 'CONNECTING' : reviewing ? 'PHOTO' : camera.status,
      Boolean(camera.stream) && !reviewing && camera.status === 'LIVE');
    if (reviewing) return;
    placeholder.hidden = Boolean(camera.stream);
    actualSettings.hidden = !camera.stream;
    if (!camera.stream) {
      actualSettings.textContent = '';
      previewRatio = 16 / 9;
      fitPreview();
      return;
    }
    const settings = camera.stream.getVideoTracks()[0].getSettings();
    const width = video.videoWidth || settings.width;
    const height = video.videoHeight || settings.height;
    actualSettings.textContent = width && height
      ? `${width} × ${height}${settings.frameRate ? ` / ${Math.round(settings.frameRate)} fps` : ''}` : 'CONNECTING';
    if (width && height) {
      previewRatio = width / height;
      fitPreview();
    }
  }

  function renderDevices(camera: CameraState) {
    cameraSelect.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = t('自動');
    cameraSelect.append(automatic);
    camera.devices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || t('カメラ {number}', { number: index + 1 });
      cameraSelect.append(option);
    });
    cameraSelect.value = camera.cameraId;
  }

  async function attachStream(stream: MediaStream) {
    video.srcObject = stream;
    await video.play();
  }

  async function preparePhoto(photo: Photo) {
    const url = URL.createObjectURL(photo.original);
    const image = document.createElement('img');
    image.id = 'captured-photo';
    image.src = url;
    try {
      await Promise.all([image.decode(), thumbnailImage(photo).decode().catch(() => {})]);
      return { image, url };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function showPreparedPhoto(prepared: { image: HTMLImageElement; url: string }, photo: Photo) {
    cancelPhotoAnimations();
    capturedPhoto.removeAttribute('src');
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    capturedPhoto = prepared.image;
    photoUrl = prepared.url;
    capturedPhoto.alt = t('撮影した写真');
    photoReview.replaceChildren(capturedPhoto);
    photoReview.hidden = false;
    placeholder.hidden = true;
    viewfinder.classList.add('is-review');
    previewRatio = photo.width / photo.height;
    actualSettings.hidden = false;
    actualSettings.textContent = `${photo.width} × ${photo.height}`;
    fitPreview();
  }

  function clearPhoto(stream: MediaStream | null) {
    cancelPhotoAnimations();
    hidePhoto();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    viewfinder.classList.remove('is-review');
    placeholder.hidden = Boolean(stream);
    previewRatio = video.videoWidth && stream ? video.videoWidth / video.videoHeight : 16 / 9;
    fitPreview();
  }

  function hidePhoto() {
    photoReview.hidden = true;
    capturedPhoto.removeAttribute('src');
  }

  function renderCountdown(seconds: number | null) {
    countdown.hidden = seconds === null;
    countdown.textContent = seconds === null ? '' : String(seconds);
  }

  function flashCapture() {
    if (reducedMotion.matches) return;
    const animation = flash.animate([{ opacity: 0.75 }, { opacity: 0 }], { duration: 180 });
    void animation.finished.catch(() => {});
    animations.push(animation);
  }

  function returnDestination(selectedPhotoId: number | null, pendingPhotoId: number | null) {
    const destination = pendingPhotoId === selectedPhotoId ? newThumbnailTarget
      : galleryList.querySelector<HTMLButtonElement>(`[data-photo-id="${selectedPhotoId}"]`) || newThumbnailTarget;
    return destination.getBoundingClientRect();
  }

  async function returnPhoto(afterCapture: boolean, destinationRect: DOMRect) {
    // Keep the departing image independent of the next capture and preview.
    const returningPhoto = document.createElement('div');
    returningPhoto.className = 'photo-review returning-photo';
    returningPhoto.setAttribute('aria-hidden', 'true');
    // Keep older departures in front of a new full-size departing image.
    for (const element of returningPhotos.keys()) {
      element.style.zIndex = String(Number(element.style.zIndex) + 1);
    }
    returningPhoto.style.zIndex = '2';
    const departingImage = afterCapture ? capturedPhoto.cloneNode(true) as HTMLImageElement : capturedPhoto;
    departingImage.removeAttribute('id');
    returningPhoto.append(departingImage);
    mediaSurface.append(returningPhoto);
    returningPhotos.set(returningPhoto, { url: photoUrl!, animation: null });
    photoUrl = null;
    if (!afterCapture) {
      capturedPhoto = document.createElement('img');
      capturedPhoto.id = 'captured-photo';
      capturedPhoto.alt = t("撮影した写真");
      photoReview.replaceChildren(capturedPhoto);
      photoReview.hidden = true;
    }
    const duration = afterCapture ? 2000 : 300;
    let returnTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const animation = returningPhoto.animate(
        returnKeyframes(returningPhoto.getBoundingClientRect(), destinationRect),
        { duration, easing: 'cubic-bezier(.05,.7,.05,1)', fill: 'forwards' },
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
  }
  function releaseDownload(url: string) {
    const download = downloads.get(url);
    if (!download) return;
    clearTimeout(download.timer);
    URL.revokeObjectURL(url);
    downloads.delete(url);
  }

  function downloadPhoto(photo: Photo) {
    const url = URL.createObjectURL(photo.original);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = photoFilename(photo);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    downloads.set(url, { photoId: photo.id, timer: setTimeout(() => releaseDownload(url), 60000) });
  }

  function releasePhotoDownloads(id: number) {
    for (const [url, download] of downloads) if (download.photoId === id) releaseDownload(url);
  }

  function reset() {
    for (const [animation, departing] of galleryAnimations) {
      animation.cancel();
      departing?.remove();
    }
    galleryAnimations.clear();
    for (const [element, entry] of returningPhotos) {
      entry.animation?.cancel();
      releaseReturningPhoto(element);
    }
    gallerySpaceAnimation?.cancel();
    gallerySpaceAnimation = null;
    gallerySpacePhotoId = null;
  }

  function releaseDownloads() {
    for (const url of downloads.keys()) releaseDownload(url);
  }

  function setNotice(next: TranslationMessage | null) {
    notice = next;
    status.textContent = notice ? t(notice.key, notice.values) : '';
  }

  function setCameraMessage(next: TranslationMessage) {
    cameraMessage = next;
    message.textContent = t(cameraMessage.key, cameraMessage.values);
  }

  function updateLanguage() {
    capturedPhoto.alt = t('撮影した写真');
    setNotice(notice);
    setCameraMessage(cameraMessage);
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

  function updateFullscreen() {
    const active = document.fullscreenElement === viewfinder;
    const label = active ? t("フルスクリーンを終了") : t("フルスクリーン");
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.setAttribute('aria-pressed', String(active));
    fullscreenButton.title = fullscreenButton.disabled ? t('このブラウザではフルスクリーンを利用できません') : `${label} (F)`;
    fitPreview();
  }

  fullscreenButton.disabled = !document.fullscreenEnabled || !viewfinder.requestFullscreen;
  if (fullscreenButton.disabled) fullscreenButton.title = t("このブラウザではフルスクリーンを利用できません");
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewfinder.requestFullscreen();
    } catch {
      setNotice({ key: "フルスクリーンに切り替えられませんでした。ブラウザの設定を確認してください。" });
    }
    updateFullscreen();
  }

  return { elements, renderControls, renderCamera, renderDevices, renderGallery, attachStream,
    preparePhoto, showPreparedPhoto, clearPhoto, hidePhoto, renderCountdown, flashCapture,
    returnDestination, returnPhoto, downloadPhoto, releasePhotoDownloads, reset, releaseDownloads,
    detachStream: () => { video.srcObject = null; },
    clearThumbnails: () => thumbnailImages.clear(), setNotice, setCameraMessage, updateLanguage, updateFullscreen, toggleFullscreen,
    scrollGalleryToStart: () => { galleryList.scrollLeft = 0; },
    discardPreparedPhoto: (prepared: { url: string }) => URL.revokeObjectURL(prepared.url),
    get reducedMotion() { return reducedMotion.matches; } };
}

export type BoothView = ReturnType<typeof createView>;
