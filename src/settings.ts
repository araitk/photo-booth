interface SavedSettings {
  timer: string;
  resolution: string;
  cameraId: string;
}

const settingsStorageKey = 'photo-booth.settings.v1';

export function loadSettings(): Partial<SavedSettings> {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
    if (!saved || typeof saved !== 'object') return {};
    const settings: Partial<SavedSettings> = {};
    if (['0', '3', '5', '10'].includes(saved.timer)) settings.timer = saved.timer;
    if (['auto', '720', '1080', '2160'].includes(saved.resolution)) settings.resolution = saved.resolution;
    if (typeof saved.cameraId === 'string') settings.cameraId = saved.cameraId;
    return settings;
  } catch {
    // Keep the defaults if storage is unavailable or the saved data is invalid.
    return {};
  }
}

export function persistSettings(settings: SavedSettings): void {
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  } catch {
    // Camera controls remain usable when the browser blocks storage.
  }
}
