# Photo Booth

ブラウザで写真を撮影・保存できるカメラアプリ。

[Photo Booth](https://araitk.github.io/photo-booth/)

## 機能

- カメラ・解像度の選択（自動・720p・1080p・4K）
- タイマー撮影（3・5・10秒）
- 写真一覧・保存
- 全画面表示・グリッド
- 英語・日本語に対応

## 使い方

「カメラを開始」でカメラの使用を許可し、撮影します。  
写真一覧から選んで保存できます。ショートカットは `?` で確認できます。

映像や写真は外部に送信されません。  
**ページを閉じる・再読み込みすると写真は消えるため、必要な写真は保存してください。**

## 開発

TypeScript・HTML/CSS・Vite。Node.js 24以上とpnpmを使用します。

```sh
pnpm install
pnpm dev
```

表示されたlocalhostのURLをブラウザで開きます。

```sh
pnpm test     # 自動テスト
pnpm build    # 型チェック・ビルド
pnpm preview  # ビルド結果の確認
```
