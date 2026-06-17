// popup.js

const $ = (sel) => document.querySelector(sel);

async function init() {
  // APIキー確認
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const hasApi = Boolean(apiKey);

  if (hasApi) {
    $('#mode-basic').classList.remove('mode-badge--active');
    $('#mode-ai').removeAttribute('hidden');
    $('#mode-ai').classList.add('mode-badge--active');
    $('#no-api-notice').hidden = true;
    $('#has-api-notice').hidden = false;
  }

  // 現在タブがPDFかチェック
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isPdf = url.endsWith('.pdf') || url.includes('.pdf?') || tab?.title?.endsWith('.pdf');

  if (!isPdf) {
    $('#state-ready').hidden = true;
    $('#state-no-pdf').hidden = false;
    return;
  }

  // ページ範囲UI制御
  const radios = document.querySelectorAll('input[name="range-mode"]');
  const allCheck = $('#all-pages');
  const singleInput = $('#page-single');
  const fromInput = $('#page-from');
  const toInput = $('#page-to');

  function updateRangeState() {
    const isAll = allCheck.checked;
    radios.forEach((r) => { r.disabled = isAll; });
    singleInput.disabled = isAll;
    fromInput.disabled = isAll;
    toInput.disabled = isAll;
  }

  allCheck.addEventListener('change', updateRangeState);

  // オプション画面を開く
  $('#open-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });
  $('#footer-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 実行ボタン
  $('#btn-run').addEventListener('click', async () => {
    const isAll = allCheck.checked;
    let pageRange;

    if (isAll) {
      pageRange = { mode: 'all' };
    } else {
      const mode = document.querySelector('input[name="range-mode"]:checked').value;
      if (mode === 'single') {
        const p = parseInt(singleInput.value, 10) || 1;
        pageRange = { mode: 'single', page: p };
      } else {
        const from = parseInt(fromInput.value, 10) || 1;
        const to = parseInt(toInput.value, 10) || from;
        pageRange = { mode: 'range', from, to: Math.max(from, to) };
      }
    }

    // storageに処理依頼を書く（window.close()前に必ず完了させる）
    await chrome.storage.local.set({
      pendingJob: {
        url: tab.url,
        tabId: tab.id,
        pageRange,
        hasApi,
        timestamp: Date.now(),
      },
    });

    // Side Panelを開く
    await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });

    window.close();
  });
}

init();
