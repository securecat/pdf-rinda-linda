// options.js

const apiKeyInput = document.getElementById('api-key');
const btnSave = document.getElementById('btn-save');
const btnClear = document.getElementById('btn-clear');
const btnToggle = document.getElementById('btn-toggle-visibility');
const saveStatus = document.getElementById('save-status');

// 現在のAPIキーを読み込む
async function load() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) {
    apiKeyInput.value = apiKey;
  }
}

// 保存
btnSave.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    saveStatus.textContent = 'APIキーを入力してください';
    saveStatus.style.color = 'var(--c-danger)';
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    saveStatus.textContent = 'Anthropic APIキーは sk-ant- で始まります';
    saveStatus.style.color = 'var(--c-danger)';
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  saveStatus.textContent = '保存しました';
  saveStatus.style.color = 'var(--c-good)';
  setTimeout(() => { saveStatus.textContent = ''; }, 3000);
});

// 削除
btnClear.addEventListener('click', async () => {
  if (!confirm('APIキーを削除しますか？')) return;
  await chrome.storage.local.remove('apiKey');
  apiKeyInput.value = '';
  saveStatus.textContent = '削除しました';
  saveStatus.style.color = 'var(--c-text-sub)';
  setTimeout(() => { saveStatus.textContent = ''; }, 3000);
});

// 表示/非表示トグル
btnToggle.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

load();
