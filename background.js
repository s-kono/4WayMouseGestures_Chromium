// content.js からのメッセージを受けて、タブ操作を行う
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return;

  if (message.type === 'gesture') {
    handleGesture(message.gesture, tabId);
  } else if (message.type === 'switch-active-tab') {
    switchActiveTab(message.direction, tabId);
  }
});

function handleGesture(gesture, tabId) {
  switch (gesture) {
    case 'down':
      chrome.tabs.remove(tabId).catch(() => {});
      break;
    case 'up':
      chrome.tabs.reload(tabId).catch(() => {});
      break;
    case 'left':
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { history.back(); } catch (e) {} }
      }).catch(() => {});
      break;
    case 'right':
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { history.forward(); } catch (e) {} }
      }).catch(() => {});
      break;
  }
}

async function switchActiveTab(direction, senderTabId) {
  try {
    const senderTab = await chrome.tabs.get(senderTabId);
    const tabs = await chrome.tabs.query({ windowId: senderTab.windowId });
    const ordered = tabs.filter((t) => typeof t.id === 'number');
    const current = ordered.findIndex((t) => t.id === senderTabId);
    if (current === -1 || ordered.length < 2) return;

    const step = direction < 0 ? -1 : 1;
    const target = ordered[(current + step + ordered.length) % ordered.length];
    if (!target) return;

    await chrome.tabs.update(target.id, { active: true });

    // 切り替え先のタブでは右ボタンが押されたままなので、
    // 離したときのコンテキストメニューを抑止してもらう
    chrome.tabs.sendMessage(target.id, { type: 'right-button-carried' }).catch(() => {});
  } catch (e) {
    // タブが閉じられた等。何もしない
  }
}
