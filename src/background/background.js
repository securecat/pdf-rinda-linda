// background.js
// Side Panelの制御

console.log('🟢 background.js loaded');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 message received:', message.type);

  if (message.type === 'OPEN_SIDE_PANEL') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
          console.error('Side Panel open error:', err);
        });
      }
    });
    sendResponse({ ok: true });
    return true;
  }
});
