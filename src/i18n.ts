export type Language = 'ja' | 'en';

const english = {
  "カメラ": "Camera",
  "自動": "Auto",
  "解像度": "Resolution",
  "タイマー": "Timer",
  "なし": "Off",
  "3秒": "3 sec",
  "5秒": "5 sec",
  "10秒": "10 sec",
  "ショートカット一覧": "Keyboard shortcuts",
  "ショートカット一覧 (?)": "Keyboard shortcuts (?)",
  "左右反転したカメラプレビュー": "Mirrored camera preview",
  "カメラに戻る": "Return to camera",
  "撮影した写真": "Captured photo",
  "カメラの使用を許可すると映像が表示されます。": "Allow camera access to see the preview.",
  "カメラを開始": "Start camera",
  "フルスクリーン": "Full screen",
  "フルスクリーン (F)": "Full screen (F)",
  "撮影": "Take photo",
  "撮影 (Space)": "Take photo (Space)",
  "写真をダウンロード": "Download photo",
  "写真をダウンロード (S)": "Download photo (S)",
  "写真を削除": "Delete photo",
  "写真": "Photos",
  "削除した写真を元に戻す": "Restore deleted photo",
  "削除した写真を元に戻す（次の撮影まで） (Z)": "Restore deleted photos until the next capture (Z)",
  "元に戻す": "Undo",
  "まだ写真がありません": "No photos yet",
  "写真一覧": "Photo gallery",
  "ショートカット": "Keyboard shortcuts",
  "閉じる": "Close",
  "全画面表示を切り替え": "Toggle full screen",
  "撮影／タイマーをキャンセル／プレビューを閉じる": "Take photo / Cancel timer / Close preview",
  "プレビュー写真を切り替え": "Switch preview photos",
  "プレビューを開く": "Open preview",
  "プレビューを閉じる": "Close preview",
  "選択中の写真を保存": "Save selected photo",
  "選択中の写真を削除": "Delete selected photo",
  "削除した写真を元に戻す（次の撮影まで）": "Restore deleted photos until the next capture",
  "この一覧を表示／閉じる": "Show / Hide shortcuts",
  "撮影をキャンセル": "Cancel capture",
  "撮影をキャンセル (Space / Esc)": "Cancel capture (Space / Esc)",
  "写真 {number}": "Photo {number}",
  "写真 {number} を表示": "View photo {number}",
  "写真 {number} を表示（ダウンロード済み）": "View photo {number} (downloaded)",
  "{total}枚中{number}枚目": "Photo {number} of {total}",
  "写真を表示できませんでした。": "Could not display the photo.",
  "撮影できませんでした。もう一度お試しください。": "Could not take the photo. Please try again.",
  "カメラを開始できませんでした。もう一度お試しください。": "Could not start the camera. Please try again.",
  "カメラの使用を許可してください。ブラウザのサイト設定から変更できます。": "Allow camera access in your browser’s site settings.",
  "カメラが見つかりません。接続を確認してください。": "No camera found. Check the connection.",
  "カメラを使用できません。他のアプリで使用中でないか確認してください。": "Camera unavailable. Check whether another app is using it.",
  "指定した設定を利用できません。別の解像度をお試しください。": "These settings are unavailable. Try a different resolution.",
  "カメラを開始できませんでした。接続とブラウザの設定を確認してください。": "Could not start the camera. Check the connection and browser settings.",
  "カメラ {number}": "Camera {number}",
  "接続中…": "Connecting…",
  "カメラが対応する解像度で開始しました。": "Started with a resolution supported by the camera.",
  "カメラとの接続が切れました。もう一度開始してください。": "Camera disconnected. Please start it again.",
  "カメラを切り替えられませんでした。元のカメラを使用します。": "Could not switch cameras. Using the previous camera.",
  "このブラウザではカメラを利用できません。対応ブラウザまたはlocalhostから開いてください。": "Camera access is unavailable. Use a supported browser over HTTPS or localhost.",
  "この解像度は利用できません。変更前の設定に戻しました。": "This resolution is unavailable. Restored the previous settings.",
  "フルスクリーンを終了": "Exit full screen",
  "このブラウザではフルスクリーンを利用できません": "Full screen is unavailable in this browser",
  "フルスクリーンに切り替えられませんでした。ブラウザの設定を確認してください。": "Could not toggle full screen. Check your browser settings.",
  "言語": "Language",
} as const;

type TranslationKey = keyof typeof english;
let language: Language = 'ja';

export function initLanguage(preference?: Language): void {
  language = preference ?? (navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en');
}

export function getLanguage(): Language { return language; }

export function t(key: TranslationKey, values: Record<string, string | number> = {}): string {
  const text = language === 'ja' ? key : english[key];
  return text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}

export function translateCurrentText(text: string): string {
  for (const key of Object.keys(english) as TranslationKey[]) {
    if (text === key || text === english[key]) return t(key);
  }
  return text;
}

export function applyLanguage(next: Language = language): void {
  language = next;
  document.documentElement.lang = language;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n as TranslationKey);
  });
  for (const attribute of ['aria-label', 'title', 'alt']) {
    document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach(element => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`) as TranslationKey));
    });
  }
}
