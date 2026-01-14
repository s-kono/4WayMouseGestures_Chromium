chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.gesture) return;
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  switch (message.gesture) {
    case 'down':
      // タブを閉じる
      chrome.tabs.remove(tabId).catch(() => {});
      break;
    case 'up':
      // リロード
      chrome.tabs.reload(tabId).catch(() => {});
      break;
    case 'left':
      // 履歴戻る（ページ内で history.back() を実行）
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { history.back(); } catch (e) {} }
      }).catch(() => {});
      break;
    case 'right':
      // 履歴進む
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { history.forward(); } catch (e) {} }
      }).catch(() => {});
      break;
    default:
      break;
  }
});

