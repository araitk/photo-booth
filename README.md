# <img src="assets/logo.svg" width="32" height="32" alt="" align="center" /> Photo Booth

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
pnpm test       # 自動テスト
pnpm typecheck  # 型・未使用コードのチェック
pnpm build      # 型チェック・ビルド
pnpm preview    # ビルド結果の確認
```

`pnpm typecheck`はアプリ本体・E2Eテスト・Playwright/Vite設定を検証します。
`pnpm build`でも同じチェックを実行します。

ブラウザでの回帰テストは、初回にテスト用ブラウザをインストールして実行します。

```sh
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
```

撮影テストはChromiumの仮想カメラを使い、実機のカメラにはアクセスしません。
言語・設定・キーボード操作はChromium・Firefox・WebKitで確認します。

4Kで10枚連続撮影する計測・回帰テストは、次のコマンドで個別に実行できます。

```sh
pnpm test:e2e --project=chromium tests/e2e/memory.spec.ts
```

`test-results/`のJSON添付には、生成したPNG・サムネイルのバイト数、
撮影・削除・次の撮影・ページ離脱後のObject URL数を記録します。
ブラウザ全体のメモリ使用量ではなく、仮想カメラ画像の圧縮データ量とURL寿命の計測です。
被写体によりPNGのサイズは変わります。削除写真は次の撮影まで取り消し用に保持します。
