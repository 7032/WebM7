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
CHANGELOG.md        更新履歴（Markdownテーブル形式、モーダルに動的読み込み）
css/
  style.css         スタイルシート
js/
  fm7.js            システム全体の統合クラス（メモリマップ、I/O、スケジューラ連携）
  cpu6809.js        MC6809 CPU エミュレーション
  display.js        画面描画（VRAM、ALU、ライン描画、パレット、320×200/640×200）
  fdc.js            フロッピーディスクコントローラ（MB8877、D77/2Dパーサ）
  cmt.js            カセットテープコントローラ（T77パーサ、バイトオーダー自動検出、FSKスケール自動検出）
  keyboard.js       キーボード入力（FM-7 ASCIIモード / FM77AV スキャンコードモード）
  psg.js            PSG音源（AY-3-8910）
  opn.js            OPN FM音源（YM2203: 3ch FM合成 + SSG + タイマー）
  scheduler.js      タイミング制御（デュアルCPU同期、イベントスケジューラ）
docs/
  fm77av-design.md      FM77AV対応 設計書
  fm77av-hardware-ref.md FM77AV ハードウェアリファレンス（FM-7との差分）
```

## 対応機種

| 機種 | 画面モード | 音源 | キーボード |
|------|-----------|------|-----------|
| FM-7 | 640×200 8色 | PSG (AY-3-8910) | ASCIIコード |
| FM77AV | 640×200 8色 / 320×200 4096色 | PSG + OPN FM (YM2203) | スキャンコード + ブレイクコード |

## ライセンス

[MIT License](LICENSE.md) © 2026 [7032](https://x.com/7032) / Naomitsu Tsugiiwa
