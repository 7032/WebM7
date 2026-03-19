# WebM7 — FM-7 Web Emulator

ブラウザ上で動く FM-7 のエミュレータです。

ROMデータの著作権は富士通株式会社に帰属します。違法に入手したROMを使用しないでください。
Windows版、Mac版等の著名なエミュレータ同様、必要なROMファイルは各自でご用意ください。

※ 本エミュレータは教育・研究・保存目的で開発されたものです。使用にあたっては各自の責任で、関連する法律を遵守してください。

※「FM-7」「FUJITSU MICRO 7」「F-BASIC」は富士通株式会社の商標または登録商標です。本プロジェクトは富士通株式会社とは一切関係ありません。

> 開発者向け情報（ローカルでの起動方法・ソース構成など）は [HOWTO.md](HOWTO.md) を参照してください。

## 使い方

### 1. ROMファイルを読み込む

エミュレータの起動には以下の ROM ファイルが必要です（実機から吸い出したものを用意してください）。

| ファイル名 | 内容 |
|---|---|
| `fbasic30.rom` | F-BASIC V3.0 ROM |
| `boot_dos.rom` | DOS ブート ROM |
| `subsys_c.rom` | サブシステム ROM |
| `SUBSYSCG.ROM` | キャラクタージェネレータ ROM |

読み込み方法は2通りあります。

- **フォルダ指定** — 「Folder」で上記ファイルが入ったフォルダを選択
- **個別指定** — 各 ROM を1つずつファイル選択

各 ROM の横に「OK」と表示されれば読み込み成功です。

### 2. ディスクイメージをセットする（任意）

D77 形式のディスクイメージを「Drive 0」にセットできます。

### 3. 起動

1. **Boot Mode** を選択（DOS / BASIC）
2. **Start** ボタンを押す

画面（Screen）をクリックするとキーボード入力がエミュレータに渡ります。

## 画面の説明

メイン画面は左右2カラムで構成されています。

### 左側 — エミュレータ画面

- **Screen** — FM-7 の映像出力（640×200、スキャンライン付き）。クリックするとキーボード入力がエミュレータに渡ります。
- **Toolbar** — 画面下のバーに音量調整（VOL）、FPS表示、FM-7キーコード、INPUT（入力モニター）、FULL（フルスクリーン / F11）があります。

### 右側 — サイドパネル

| セクション | 内容 |
|---|---|
| **Control** | Boot Mode（DOS / BASIC）の選択と Start / Stop / Reset ボタン |
| **ROM Files** | ROM ファイルの読み込み（フォルダ一括 or 個別指定）。各 ROM の横に OK が出れば成功 |
| **Disk Image** | D77 形式のディスクイメージを Drive 0 にセット |
| **Debug** | 動作状態（State / FPS / Main PC / Sub PC / Sub CPU）、キーボード入力表示、パレット、PSG レジスタ |

## Input Monitor

ツールバーの **INPUT** ボタンで開閉するフローティングパネルです。

- **Held Keys** — 現在押下中のキー一覧
- **FM-7 Key** — エミュレータに渡されたキーコード（16進数）とバッファ残数
- **Joystick** — ゲームパッドの方向・ボタン状態をリアルタイム表示。PCのゲームパッドを接続するとFM-7のジョイスティックとして使用できます。

## 参考にさせて頂いた資料

- Motorola MC6809 Programming Manual / Data Sheet
- Fujitsu MB8877 Data Sheet
- General Instrument AY-3-8910 Data Sheet
- 富士通 FM-7 テクニカルリファレンスマニュアル
- [D88 Disk Image Format Specification](https://www.pc98.org/project/doc/d88.html)

## ライセンス

[MIT License](LICENSE.md) © 2026 [7032](https://x.com/7032) / Naomitsu Tsugiiwa

本ライセンスは WebM7 自体のソースコード（JavaScript, HTML, CSS）に適用されます。ROMデータや第三者の著作物は含まれません。
