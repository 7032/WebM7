// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// WebM7 Service Worker — PWA オフライン対応 (GitHub Pages 単体動作)
//   全パス相対。SW の置かれたディレクトリがスコープになるため、project pages の
//   サブパス公開でも独自ドメインのルート公開でも同じく動く。
//   アプリシェル(HTML/エンジン/CSS/アイコン/必須md)を install 時にプリキャッシュし、
//   それ以外は cache-first + ネットワークフォールバックで応答。
// =============================================================================
const CACHE = 'webm7-20260818222120';

// 相対 URL でプリキャッシュ (SW スコープ基準で解決される)
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './css/softkbd.css',
  // エンジン (core/)
  './core/index.js',
  './core/fm7.js',
  './core/cpu6809.js',
  './core/scheduler.js',
  './core/fdc.js',
  './core/hfe.js',
  './core/cmt.js',
  './core/fdd_sound.js',
  './core/opn.js',
  './core/psg.js',
  './core/audio-worklet-processor.js',
  './core/keyboard.js',
  './core/cgrom_glyph.js',
  './core/display.js',
  './core/softkbd.js',
  // アイコン
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  // 実行時に取得するドキュメント
  './CHANGELOG.md',
  './docs/Tape_Manual.md',
  './docs/Tutorial.md',
  './docs/Headless_Test_Manual.md',
  // docs/images/*.svg は点数が多いためプリキャッシュせず実行時キャッシュに任せる
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll は1つでも失敗すると全体が失敗するため、個別に best-effort で入れる
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ローカル開発(localhost/127.0.0.1/file)では cache-first が古いファイルを
// 配信し続け開発を阻害するため、ネット優先(network-first)で常に最新を取得。
const DEV = self.location.hostname === 'localhost'
         || self.location.hostname === '127.0.0.1'
         || self.location.hostname === '';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 開発時: 常にネットから取得(取れなければキャッシュ)。古い資産を掴まない。
  if (DEV) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // ページ遷移はキャッシュした index.html にフォールバック (オフライン起動)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // それ以外は cache-first → ネット取得しキャッシュへ
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => hit))
  );
});
