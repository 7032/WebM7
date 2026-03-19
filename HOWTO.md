# HOWTO — 開発者向けガイド

WebM7 をローカル環境で動かす方法と、ソースコードの構成について説明します。

## ローカルでの起動方法

ES Modules (`import`) を使っているため、ファイルを直接ブラウザで開くと動きません。ローカルに HTTP サーバーを立ててください。

※ Visual Studio Code の Live Server 拡張がオススメです。

```bash
# Python 3 の場合
python -m http.server 8080

# Node.js (npx) の場合
npx serve .
```

ブラウザで `http://localhost:8080` を開きます。

ROM ファイルの読み込みや操作方法については [README.md](README.md) を参照してください。

## ソース構成

```
index.html          メイン画面 & UI
css/
  style.css         スタイルシート
js/
  fm7.js            システム全体の統合クラス
  cpu6809.js        MC6809 CPU エミュレーション
  display.js        画面描画（サブCPU側VRAM管理）
  fdc.js            フロッピーディスクコントローラ
  keyboard.js       キーボード入力
  psg.js            サウンド（PSG）
  scheduler.js      タイミング制御
```

## ライセンス

[MIT License](LICENSE.md) © 2026 [7032](https://x.com/7032) / Naomitsu Tsugiiwa
