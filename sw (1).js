// ACE LABO PWA Service Worker
// 方針：
//  - HTML/CSS/JS（アプリ本体）は「ネットワーク優先」。
//    → オンラインなら常に最新を取得。更新が即反映される。
//    → オフライン時のみキャッシュから起動。
//  - 画像（ロゴ・アイコン）は「キャッシュ優先」。滅多に変わらず高速。
//  - GAS API（データ通信）はキャッシュせず常にネットワークへ。

const CACHE_VERSION = 'acelabo-v2';

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

// 画像系（キャッシュ優先で扱う拡張子）
function isImage(url) {
  return /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(url.pathname);
}

// インストール：アプリシェルを事前キャッシュし、すぐ新SWを有効化
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(APP_SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

// 有効化：古いバージョンのキャッシュを全削除して即制御開始
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // API POST等は素通し

  const url = new URL(req.url);

  // GAS API はキャッシュしない（常に最新データ）
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com')) {
    return;
  }

  // 画像：キャッシュ優先（無ければ取得してキャッシュ）
  if (isImage(url)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return resp;
        })
      )
    );
    return;
  }

  // それ以外（HTML/CSS/JS）：ネットワーク優先
  //   取得成功→キャッシュを更新して返す / 失敗→キャッシュにフォールバック
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});

// ページからの指示で即時更新（任意）
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
