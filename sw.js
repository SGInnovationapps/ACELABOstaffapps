// ACE LABO PWA Service Worker
// アプリの「外枠」（HTML/CSS/JS/アイコン）をキャッシュし、
// オフラインでも起動できるようにする。
// データAPI（GAS）への通信はキャッシュせず常にネットワークへ。

const CACHE_VERSION = 'acelabo-v1';
const APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

// インストール時：アプリシェルを事前キャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // 個別に追加し、1つ失敗しても全体を止めない
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// 有効化時：古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET以外（API POST など）はキャッシュ対象外。素通し。
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // GAS API への通信はキャッシュしない（常に最新データを取得）
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com')) {
    return; // デフォルトのネットワーク処理に任せる
  }

  // アプリシェル：キャッシュ優先（オフライン対応）、
  // 取得できたらバックグラウンドでキャッシュ更新（stale-while-revalidate）
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
