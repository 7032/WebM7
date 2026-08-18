# WebM7 — FM-7 / FM77AV シリーズ Web Emulator

ブラウザ上で動く FM-7 / FM77AV シリーズ（FM-7 / FM77AV / FM77AV20 / FM77AV20EX / FM77AV40 / FM77AV40EX/SX）のエミュレータです。
GitHub Pages で動くページは https://7032.github.io/WebM7/ になります。
ROMデータの著作権は富士通株式会社に帰属します。違法に入手したROMを使用しないでください。
Windows版、Mac版等の著名なエミュレータ同様、必要なROMファイルは各自でご用意ください。日本国内でのご利用にあたっては、ROMファイルの吸出し元ソフトウェア・ハードウェアを適法に入手・所有していることが前提となります。

※ 本エミュレータは開発者の意図として、教育・研究・保存を目的に開発されたものです。この文言は法的な免責を意味するものではなく、使用にあたっては各自の責任で、お住まいの国・地域の関連法令を遵守してください。

**ROMファイルの取り扱いについて / ROM File Handling**
- 本エミュレータはROMファイルをユーザーのブラウザ内（ローカル環境）でのみ処理します。ROMデータがサーバーに送信・保存されることはありません。
- ROMファイルをサーバー側に保管し配信する行為は著作権法上の公衆送信に該当するため、本プロジェクトではROMのサーバーホスティングを行いません。
- エミュレータ動作中、互換性確保を目的としてユーザーがご用意されたROMのメモリ上コピーを実行時のみ一時的に調整する処理が含まれる場合があります（例: イニシエータROMの機種判定箇所の抽象化）。実行時調整の対象は次の範囲に限られます: (1) イニシエータROMのメモリ上コピーに含まれる機種識別バイト列を選択機種に合わせて調整する、(2) 起動時に必要な割込ベクタや起動コードをROMからRAMへ写す、(3) 一部のディスクの起動手順をエミュレータ側で肩代わりして起動を補助する。いずれもブラウザのメモリ上でのみ行われ、元のROMファイルの書き換えや改変ROMの配布は行いません。ヘッドレス実行ではこれらの調整を無効化する設定（`romAdjust`）も用意しています（詳細は docs/Headless_Test_Manual.md）。
- This emulator processes ROM files entirely within the user's browser (local environment). ROM data is never transmitted to or stored on any server.
- Hosting and distributing ROM files from a server constitutes public transmission under copyright law. This project does not and will not host ROM files on any server.
- For compatibility purposes, the emulator may temporarily adjust in-memory copies of user-supplied ROMs at runtime (e.g., abstracting machine-identification bytes in the initiator ROM). The scope of these runtime adjustments is limited to: (1) adjusting the machine-identification byte sequence in the in-memory copy of the initiator ROM to match the selected model, (2) copying interrupt vectors and boot code needed at startup from ROM into RAM, and (3) assisting the boot process of certain disks by having the emulator perform part of the boot procedure. All of this happens only in browser memory; the original ROM files are never modified, and no modified ROMs are distributed. For headless runs, a setting (`romAdjust`) is available to disable these adjustments (see docs/Headless_Test_Manual.md).

※「FM-7」「FM77AV」「FUJITSU MICRO 7」「F-BASIC」は富士通株式会社の商標または登録商標です。本プロジェクトは富士通株式会社とは一切関係ありません。その他記載の製品名・チップ名は各社の商標または登録商標です。

> 開発者向け情報（ローカルでの起動方法・ソース構成など）は [HOWTO.md](HOWTO.md) を参照してください。

## 主な機能

### FM-7
- デュアル MC6809 CPU（メイン + サブ、1.2288MHz）
- 640×200 8色表示、TTLパレット
- PSG 音源（AY-3-8910）
- FDC（MB8877）、D77/2D ディスクイメージ対応
- CMT（カセットテープ）、T77 / WAV テープイメージの読み込み・保存対応
- キーボード入力（ASCIIモード、JIS 106/109配列対応、キーリピート対応）
- INS/CAPS/カナ LEDインジケーター
- カーソルキー → テンキー代替プリセット（テンキーレスキーボード対応）
- ジョイスティック（FM音源カード相当）

### FM77AV
- 320×200 4096色モード＋アナログパレット
- ALU ハードウェアアクセラレータ、ライン描画エンジン
- OPN FM 音源（YM2203: 3ch FM + SSG）
- VRAMダブルページ、CG ROMバンク切替
- 機種別の起動経路（イニシエータROM・ブートROMを実コードとして実行。一部ディスクの起動補助あり）
- サブROMバンク切替（Type-A/B/C）
- MMR（192KB拡張RAM）
- スキャンコードキーボード、ブレイクコード

### FM77AV20
- FM77AV の全機能に加え、2DD フロッピーディスク対応

### FM77AV20EX
- FM77AV20 の全機能に加え、DMAC（HD6844）と高速MMR（MMR 使用時の速度低下を抑止）に対応

### FM77AV40
- 640×400 8色モード（400ライン表示）
- 320×200 262,144色モード
- MMR拡張モード（448KB拡張RAM、8バンク）
- RD512 / DMAC / CRTC スタブ対応

### FM77AV40EX/SX
- FM77AV40 の全機能に加え、EXTSUB.ROM（拡張サブシステム Type-D/E）に対応
- サブROMバンク切替（Type-A/B/C/D/E）

### 共通機能
- Boot Mode 選択（Auto / DOS / BASIC）
- ディスク / テープのライブラリ管理（ブラウザ内に複数イメージを保管・命名・挿入）
- ディスクの論理フォーマット（FAT / ディレクトリ初期化。空ディスクを `SAVE` 可能にする）
- FDD動作音（シーク・ヘッドロード・スピンドルモーター・ディスク挿入/取出し音を合成再現）
- スクリーンショットPNG保存（640×400 で出力）
- 仮想キーボード（タッチ端末で表示。スマホ縦向きでは専用レイアウトに自動切替し、画面直下にドック）
- キーカスタマイズ（物理キーボード種別の選択、FM-7キーへの物理キー割当、ブラウザ保存）
- Keyboard パネルのキーをクリックして入力（ソフトウェアキーボード。PC・タッチ共通）
- ROM Info（読み込み済みROMのサイズ・ハッシュ表示、クリップボードへコピー）

## 使い方

### 1. ROMファイルを読み込む

エミュレータの起動には以下の ROM ファイルが必要です（実機から吸い出したものを用意してください）。

#### FM-7 共通ROM

| ファイル名 | 内容 |
|---|---|
| `FBASIC30.ROM` | F-BASIC V3.0 ROM（本体搭載 ROM。起動に常に必須） |
| `BOOT_BAS.ROM` | BASIC ブート ROM（FM-7 系を Boot Mode: BASIC で起動する場合に必須。本体内蔵のブート ROM 相当） |
| `BOOT_DOS.ROM` | DOS ブート ROM（FM-7 系を Boot Mode: DOS で起動する場合に必須） |
| `SUBSYS_C.ROM` | サブシステム ROM（CGフォント内蔵）。起動に常に必須 |
| `KANJI.ROM`    | 漢字 ROM（JIS第一水準）。**任意**。漢字ROMカード相当で、指定すると漢字を使うソフトで漢字が表示されます |

#### FM77AV 追加ROM

| ファイル名 | 内容 |
|---|---|
| `INITIATE.ROM` | イニシエータROM。FM77AV 系の起動に必須（`BOOT_BAS.ROM` / `BOOT_DOS.ROM` は不要） |
| `KANJI.ROM`    | 漢字 ROM（JIS第一水準、FM77AVでは必須。FM-7 でも任意で利用可） |
| `SUBSYSCG.ROM` | キャラクタージェネレータ ROM |
| `SUBSYS_A.ROM` | サブシステム Type-A ROM |
| `SUBSYS_B.ROM` | サブシステム Type-B ROM |

#### FM77AV40EX 追加ROM

| ファイル名 | 内容 |
|---|---|
| `EXTSUB.ROM` | 拡張サブシステムROM（Type-D/E、FM77AV40EXモードで必要） |

読み込み方法は2通りあります。

- **フォルダ指定** — 「Folder」で上記ファイルが入ったフォルダを選択
- **個別指定** — 各 ROM を1つずつファイル選択

各 ROM の横に「OK」と表示されれば読み込み成功です。
読み込み後、**ROM Info** を開くと各ROMのサイズとハッシュ値を確認できます。**Copy** ボタンでクリップボードにコピーできますので、不具合をご連絡頂く際は併せてコピー＆ペースト頂けると幸いです。

### 2. メディアイメージをセットする（任意）

- **ディスク** — D77 形式のディスクイメージを「Drive 0」「Drive 1」にセットできます。セットするとファイル名が表示されます
- **テープ** — T77 / WAV 形式のカセットテープイメージを「Tape Image」にセットできます。セットするとファイル名が表示されます
  - T77 テープイメージ形式に対応。ビッグエンディアン・リトルエンディアンの両バイトオーダーを自動検出します
  - **WAV 形式**にも対応。録音のノイズ・振幅変動・テープ速度の揺らぎ（ワウフラッター）を含む実録音も、信号を復調してクリーンな搬送波として再生成する方式と直接スライスする方式を自動で切り替えて読み込みます。読み込み時にデコード品質（正常ブロック数）を表示します
  - **REW** ボタンでテープを巻き戻し
  - テープ読み込み中（モーターON時）はエミュレータが自動的に高速化され、実時間の約1/50の速度でロードされます
  - BASIC で `SAVE` / `SAVEM` した内容は自動録音され、**録音→.t77** / **録音→.wav** ボタンでファイル保存できます

### 3. 起動

1. **Machine** を選択（FM-7 / FM77AV / FM77AV20 / FM77AV20EX / FM77AV40 / FM77AV40EX/SX）。機種ごとの機能差は Machine セレクタ下の能力バッジと「機種比較」で確認できます
2. **Boot Mode** を選択
   - **Auto**（デフォルト） — ディスクイメージがセットされていれば DOS、なければ BASIC で自動起動します
   - **DOS** — フロッピーディスクから OS を起動します。ディスクイメージがセットされている必要があります
   - **BASIC** — F-BASIC V3.0 が起動します。テープからのプログラム読み込み（`RUN ""`、`LOAD`、`LOADM`）やBASICプログラミングが可能です
3. **FM Sound Card**（FM-7のみ） — チェックを入れるとFM音源カード（OPN）を有効にします
4. **FDD Sound** — チェックを入れるとフロッピーディスクの動作音（シーク・ヘッドロード・モーター音など）が鳴ります。デフォルトはOFFです。ボリュームスライダーで音量調整できます
5. **Joystick** ポートを選択（Port 1 / Port 2）
6. **Cursor → Numpad** — テンキーのないキーボードでテンキーを使うゲームを遊ぶ場合にチェックを入れると、カーソルキー（↑↓←→）がテンキーの 8/2/4/6 として動作します
7. **Power** スイッチをONにスライド
   - 起動に必要な ROM がまだ読み込まれていないときは、Power スイッチは淡色表示で操作できず、「先に ROM を読み込んでください」と案内されます。ROM を読み込むと有効になります
   - OFFにスライドで停止できます。**Pause** で一時停止、**Resume** で再開、**Reset** で再起動します
   - 📸 ボタンで画面をPNGファイルとして保存できます

画面（Screen）をクリックするとキーボード入力がエミュレータに渡ります。

## キーボード

- **クリックで入力（ソフトウェアキーボード）** — Keyboard パネル（ツールバー2行目の **Keyboard** ボタン）のキーボード図のキーをクリックすると、その文字がエミュレータに入力されます。Shift はスティッキー、GRPH は押している間のみ、CAP / カナ / CTR はトグル動作です。タッチ端末では画面下部の仮想キーボードでも同様に入力できます
- **キーカスタマイズ** — Keyboard パネルの「キーカスタマイズ」で、お使いの物理キーボードを **配列**（日本語配列 / 英語配列）と **種別**（フルキー / テンキーレス / コンパクト）で選択できます。「カスタマイズ開始」を押し、割り当てたい FM-7 キーをクリックしてから物理キーを押すと、そのキーが割り当てられます。割当はブラウザに保存され、「リセット」で既定に戻せます。FM-7 / FM77AV 共通の設定です
- **101英語キーボード向けショートカット** — `@` / `_` キーが無い配列では `Ctrl + [` → `@`、`Ctrl + /` → `_` で代替入力できます

## スマートフォン / タブレット

タッチ端末では画面下部に仮想キーボードを表示します。**縦向きのスマートフォン**では、カーソルキー・編集キー・テンキーをメインキーの下段にまとめた縦長専用レイアウトへ自動で切り替わり、キーを大きく描画します。仮想キーボードは画面のすぐ下にドック表示され、画面の回転に追従します。

## ジョイスティック

PCのゲームパッド（USB / Bluetooth）を接続すると、FM-7/FM77AV のジョイスティックとして使用できます。

- **ポート選択** — Control セクションで Port 1 / Port 2 を選択
- **ボタン割り当て** — 左スティック / D-pad = 方向、A/X = トリガー1、B/Y = トリガー2
- **2P対応** — 2つ目のゲームパッドは自動的にもう一方のポートに割り当て

## 対応ブラウザ

以下のブラウザで動作確認しています。

- Firefox（Windows）
- Google Chrome（Windows/macOS）
- Microsoft Edge（Windows）
- Safari（macOS/iPad）

## 参考にさせて頂いた資料

- Motorola MC6809 Programming Manual / Data Sheet
- Fujitsu MB8877 Data Sheet
- General Instrument AY-3-8910 Data Sheet
- Yamaha YM2203 (OPN) Application Manual
- 公開されている当時の技術情報
- [D88 Disk Image Format Specification](https://www.pc98.org/project/doc/d88.html)

## ライセンス

[MIT License](LICENSE.md) © 2026 [7032](https://x.com/7032) / Naomitsu Tsugiiwa

本ライセンスは WebM7 自体のソースコード（JavaScript, HTML, CSS）に適用されます。ROMデータや第三者の著作物は含まれません。FM音源部（core/opn.js）には別途の利用条件が適用されます。詳細は [LICENSE.md](LICENSE.md) を参照してください。
