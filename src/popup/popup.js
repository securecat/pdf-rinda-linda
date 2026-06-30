// popup.js

const $ = (sel) => document.querySelector(sel);

function bindOptionsLinks() {
  $('#footer-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

async function init() {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    $('#state-no-api').hidden = false;
    $('#btn-setup').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    bindOptionsLinks();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isPdf = url.endsWith('.pdf') || url.includes('.pdf?') || tab?.title?.endsWith('.pdf');

  if (!isPdf) {
    $('#state-no-pdf').hidden = false;
    bindOptionsLinks();
    return;
  }

  $('#state-ready').hidden = false;
  bindOptionsLinks();

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

    await chrome.storage.local.set({
      pendingJob: {
        url: tab.url,
        tabId: tab.id,
        pageRange,
        timestamp: Date.now(),
      },
    });

    await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    window.close();
  });
}

init();
