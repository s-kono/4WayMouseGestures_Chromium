// inject.js をページコンテキストに読み込ませる（document_start で実行される想定）
(function(){
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = function() { this.remove(); };
    (document.documentElement || document.head || document.body || document).appendChild(s);
  } catch (e) {
    // 例外は無視
  }

  // ページ側からの通知を受け、background に転送する
  window.addEventListener('message', (ev) => {
    if (!ev.data || !ev.data.__FWG__) return;
    const data = ev.data;
    switch (data.type) {
      case 'GESTURE':
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ gesture: data.gesture });
        }
        break;
      case 'FALLBACK_CONTEXTMENU':
        // サイト向け contextmenu を合成した、など必要ならここで処理
        break;
      case 'PAGE_CONTEXTMENU':
        // ページが contextmenu を発火した場合の通知
        break;
      default:
        break;
    }
  }, false);
})();
