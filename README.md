# WebM7 — FM-7 / FM77AV Web Emulator

ブラウザ上で動く FM-7 / FM77AV のエミュレータです。
GitHub Pages で動くページは  https://7032.github.io/WebM7/ になります。
ROMデータの著作権は富士通株式会社に帰属します。違法に入手したROMを使用しないでください。
Windows版、Mac版等の著名なエミュレータ同様、必要なROMファイルは各自でご用意ください。

※ 本エミュレータは教育・研究・保存目的で開発されたものです。使用にあたっては各自の責任で、関連する法律を遵守してください。

**ROMファイルの取り扱いについて / ROM File Handling**
- 本エミュレータはROMファイルをユーザーのブラウザ内（ローカル環境）でのみ処理します。ROMデータがサーバーに送信・保存されることはありません。
- ROMファイルをサーバー側に保管し配信する行為は著作権法上の公衆送信に該当するため、本プロジェクトではROMのサーバーホスティングを行いません。
- This emulator processes ROM files entirely within the user's browser (local environment). ROM data is never transmitted to or stored on any server.
- Hosting and distributing ROM files from a server constitutes public transmission under copyright law. This project does not and will not host ROM files on any server.

※「FM-7」「FM77AV」「FUJITSU MICRO 7」「F-BASIC」は富士通株式会社の商標または登録商標です。本プロジェクトは富士通株式会社とは一切関係ありません。

> 開発者向け情報（ローカルでの起動方法・ソース構成など）は [HOWTO.md](HOWTO.md) を参照してください。

## 主な機能

### FM-7
- デュアル MC6809 CPU（メイン + サブ、1.2288MHz）
- 640×200 8色表示、TTLパレット
- PSG 音源（AY-3-8910）
- FDC（MB8877）、D77/2D ディスクイメージ対応
- CMT（カセットテープ）、T77 テープイメージ対応
- キーボード入力（ASCIIモード、キーリピート対応）
- INS/CAPS/カナ LEDインジケーター
- ジョイスティック（FM音源カード相当）

### FM77AV
- 320×200 4096色モード＋アナログパレット
- ALU ハードウェアアクセラレータ、ライン描画エンジン
- OPN FM 音源（YM2203: 3ch FM + SSG）
- VRAMダブルページ、CG ROMバンク切替
- イニシエータROMブートシーケンス
- サブROMバンク切替（Type-A/B/C）
- MMR（192KB拡張RAM）
- スキャンコードキーボード、ブレイクコード

## 使い方

### 1. ROMファイルを読み込む

エミュレータの起動には以下の ROM ファイルが必要です（実機から吸い出したものを用意してください）。

#### FM-7 共通ROM

| ファイル名 | 内容 |
|---|---|
| `fbasic30.rom` | F-BASIC V3.0 ROM |
| `boot_dos.rom` | DOS ブート ROM |
| `subsys_c.rom` | サブシステム ROM |
| `SUBSYSCG.ROM` | キャラクタージェネレータ ROM |

#### FM77AV 追加ROM

| ファイル名 | 内容 |
|---|---|
| `INITIATE.ROM` | イニシエータ ROM |
| `SUBSYS_A.ROM` | サブシステム Type-A ROM |
| `SUBSYS_B.ROM` | サブシステム Type-B ROM |

読み込み方法は2通りあります。

- **フォルダ指定** — 「Folder」で上記ファイルが入ったフォルダを選択
- **個別指定** — 各 ROM を1つずつファイル選択

各 ROM の横に「OK」と表示されれば読み込み成功です。

### 2. メディアイメージをセットする（任意）

- **ディスク** — D77 形式のディスクイメージを「Drive 0」「Drive 1」にセットできます
- **テープ** — T77 形式のカセットテープイメージを「Tape Image」にセットできます
  - T77 テープイメージ形式に対応。ビッグエンディアン・リトルエンディアンの両バイトオーダーを自動検出します
  - **REW** ボタンでテープを巻き戻し
  - テープ読み込み中（モーターON時）はエミュレータが自動的に高速化され、実時間の約1/50の速度でロードされます

### 3. 起動

1. **Machine** を選択（FM-7 / FM77AV）
2. **Boot Mode** を選択
   - **BASIC** — F-BASIC V3.0 が起動します。テープからのプログラム読み込み（`RUN ""`、`LOAD`、`LOADM`）やBASICプログラミングが可能です
   - **DOS** — フロッピーディスクから OS を起動します。ディスクイメージがセットされている必要があります
3. **Joystick** ポートを選択（Port 1 / Port 2）
4. **Start** ボタンを押す
   - **Start/Stop** はトグルボタンです。**Pause** で一時停止、**Reset** で即座に再起動します

画面（Screen）をクリックするとキーボード入力がエミュレータに渡ります。

## ジョイスティック

PCのゲームパッド（USB / Bluetooth）を接続すると、FM-7/FM77AV のジョイスティックとして使用できます。

- **ポート選択** — Control セクションで Port 1 / Port 2 を選択
- **ボタン割り当て** — 左スティック / D-pad = 方向、A/X = トリガー1、B/Y = トリガー2
- **2P対応** — 2つ目のゲームパッドは自動的にもう一方のポートに割り当て

## 参考にさせて頂いた資料

- Motorola MC6809 Programming Manual / Data Sheet
- Fujitsu MB8877 Data Sheet
- General Instrument AY-3-8910 Data Sheet
- Yamaha YM2203 (OPN) Application Manual
- 富士通 FM-7 / FM77AV テクニカルリファレンスマニュアル
- [D88 Disk Image Format Specification](https://www.pc98.org/project/doc/d88.html)

## ライセンス

[MIT License](LICENSE.md) © 2026 [7032](https://x.com/7032) / Naomitsu Tsugiiwa

本ライセンスは WebM7 自体のソースコード（JavaScript, HTML, CSS）に適用されます。ROMデータや第三者の著作物は含まれません。
