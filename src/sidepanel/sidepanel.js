// sidepanel.js
import { extractPdfData } from '../lib/pdf-processor.js';
import { analyzePageWithAI, textLayerToMarkdown } from '../lib/claude-api.js';

const $ = (sel) => document.querySelector(sel);

// 状態
let currentMarkdown = '';
let totalCost = 0;
let speechUtterance = null;
const costBreakdown = [];

// UI要素
const progressPanel = $('#progress-panel');
const progressMessage = $('#progress-message');
const errorPanel = $('#error-panel');
const errorMessage = $('#error-message');
const idlePanel = $('#idle-panel');
const outputPanel = $('#output-panel');
const mdOutput = $('#md-output');
const costPanel = $('#cost-panel');
const costValue = $('#cost-value');
const costBreakdownEl = $('#cost-breakdown');
const btnSpeak = $('#btn-speak');
const btnStop = $('#btn-stop');
const btnCopy = $('#btn-copy');

// --- 状態切り替え ---
function showState(state) {
  progressPanel.hidden = state !== 'progress';
  errorPanel.hidden = state !== 'error';
  idlePanel.hidden = state !== 'idle';
  outputPanel.hidden = state !== 'output';
}

function setProgress(msg) {
  showState('progress');
  progressMessage.textContent = msg;
}

function showError(msg) {
  showState('error');
  errorMessage.textContent = msg;
}

// --- アクセスコスト表示 ---
function updateCost(delta, reason) {
  totalCost += delta;
  costPanel.hidden = false;
  costValue.textContent = totalCost;

  if (totalCost >= 60) {
    costValue.dataset.level = 'high';
  } else if (totalCost >= 25) {
    costValue.dataset.level = 'medium';
  } else {
    costValue.dataset.level = '';
  }

  if (reason) {
    costBreakdown.push({ delta, reason });
    const tag = document.createElement('span');
    tag.className = `cost-tag ${delta >= 10 ? 'cost-tag--warn' : ''}`;
    tag.textContent = `+${delta} ${reason}`;
    costBreakdownEl.appendChild(tag);
  }
}

// --- Markdownレンダリング（依存ライブラリなし） ---
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = '';
  const lines = md.split('\n');
  let inList = false;
  let inOrderedList = false;
  let inTable = false;
  let inCode = false;
  let codeBuffer = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeBuffer = '';
        if (inList) { html += '</ul>'; inList = false; }
        if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
      } else {
        inCode = false;
        html += `<pre><code>${esc(codeBuffer)}</code></pre>`;
      }
      continue;
    }

    if (inCode) {
      codeBuffer += (codeBuffer ? '\n' : '') + line;
      continue;
    }

    if (line.startsWith('|')) {
      if (!inTable) { inTable = true; html += '<table>'; }
      const cells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (line.includes('---')) continue;
      const isHeader = i < lines.length - 1 && lines[i + 1]?.includes('---');
      const tag = isHeader ? 'th' : 'td';
      html += '<tr>' + cells.map((c) => `<${tag}>${inlineMarkdown(c.trim())}</${tag}>`).join('') + '</tr>';
      continue;
    } else if (inTable) {
      inTable = false;
      html += '</table>';
    }

    if (inList && !line.match(/^[-*+] /)) { html += '</ul>'; inList = false; }
    if (inOrderedList && !line.match(/^\d+\. /)) { html += '</ol>'; inOrderedList = false; }

    if (line.startsWith('# ')) {
      html += `<h1>${inlineMarkdown(esc(line.slice(2)))}</h1>`;
    } else if (line.startsWith('## ')) {
      html += `<h2>${inlineMarkdown(esc(line.slice(3)))}</h2>`;
    } else if (line.startsWith('### ')) {
      html += `<h3>${inlineMarkdown(esc(line.slice(4)))}</h3>`;
    } else if (line.startsWith('#### ')) {
      html += `<h4>${inlineMarkdown(esc(line.slice(5)))}</h4>`;
    } else if (line.startsWith('> ')) {
      html += `<blockquote><p>${inlineMarkdown(esc(line.slice(2)))}</p></blockquote>`;
    } else if (line.startsWith('---') || line.startsWith('***')) {
      html += '<hr>';
    } else if (line.match(/^[-*+] /)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMarkdown(esc(line.slice(2)))}</li>`;
    } else if (line.match(/^\d+\. /)) {
      if (!inOrderedList) { html += '<ol>'; inOrderedList = true; }
      html += `<li>${inlineMarkdown(esc(line.replace(/^\d+\. /, '')))}</li>`;
    } else if (line.trim() === '') {
      html += '';
    } else {
      html += `<p>${inlineMarkdown(esc(line))}</p>`;
    }
  }

  if (inList) html += '</ul>';
  if (inOrderedList) html += '</ol>';
  if (inTable) html += '</table>';

  return html;
}

function inlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// --- メイン処理 ---
async function processPdf(payload) {
  // 同じジョブを2回処理しないようタイムスタンプを記録
  const { lastProcessedTs } = await chrome.storage.local.get('lastProcessedTs');
  if (lastProcessedTs === payload.timestamp) return;
  await chrome.storage.local.set({ lastProcessedTs: payload.timestamp });

  const { url, pageRange, hasApi } = payload;
  totalCost = 0;
  costBreakdown.length = 0;
  costBreakdownEl.innerHTML = '';
  costPanel.hidden = true;
  currentMarkdown = '';
  mdOutput.innerHTML = '';
  btnSpeak.disabled = true;
  btnCopy.disabled = true;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  const useApi = hasApi && Boolean(apiKey);

  try {
    const { pages } = await extractPdfData(url, pageRange, (msg) => {
      setProgress(msg);
    });

    showState('output');
    const allMarkdownParts = [];

    for (let i = 0; i < pages.length; i++) {
      const pageData = pages[i];
      const { pageNum, rawText, hasTextLayer, images } = pageData;

      if (i > 0) {
        mdOutput.insertAdjacentHTML('beforeend', `
          <div class="page-divider">
            <div class="page-divider-line"></div>
            <span class="page-divider-label">ページ ${pageNum}</span>
            <div class="page-divider-line"></div>
          </div>
        `);
      }

      if (!hasTextLayer) updateCost(30, 'テキストレイヤーなし');
      const imgCount = images.reduce((s, img) => s + (img.count || 0), 0);
      if (imgCount > 0) updateCost(imgCount * 5, `画像${imgCount}枚`);
      const noAltCount = images.filter((img) => !img.altText).length;
      if (noAltCount > 0) updateCost(noAltCount * 10, `alt無し${noAltCount}枚`);

      let pageMarkdown = '';

      if (useApi) {
        setProgress(`ページ ${pageNum} をAI解析中…`);
        try {
          const result = await analyzePageWithAI(apiKey, pageData, rawText);
          pageMarkdown = result.markdown;
          if (result.costDelta > 0) updateCost(result.costDelta, 'AI処理');
        } catch (apiErr) {
          console.error('AI解析エラー:', apiErr);
          pageMarkdown = textLayerToMarkdown(rawText, pageData.textItems);
          updateCost(5, 'AI失敗→フォールバック');
        }
      } else {
        pageMarkdown = textLayerToMarkdown(rawText, pageData.textItems);
        if (!hasTextLayer) {
          pageMarkdown = '*（テキストレイヤーなし。AIモードでOCR解析が可能です）*';
        }
      }

      allMarkdownParts.push(pageMarkdown);
      mdOutput.insertAdjacentHTML('beforeend', renderMarkdown(pageMarkdown));
      showState('output');
    }

    currentMarkdown = allMarkdownParts.join('\n\n---\n\n');
    btnSpeak.disabled = false;
    btnCopy.disabled = false;

  } catch (err) {
    console.error('processPdf error:', err);
    showError(`エラーが発生しました:\n${err.message}`);
  }
}

// --- 読み上げ ---
btnSpeak.addEventListener('click', () => {
  if (!currentMarkdown) return;

  const plainText = currentMarkdown
    .replace(/#{1,6} /g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^[-*+] /gm, '')
    .replace(/^\d+\. /gm, '')
    .replace(/^> /gm, '')
    .replace(/\|/g, ' ')
    .replace(/^---$/gm, '')
    .trim();

  speechUtterance = new SpeechSynthesisUtterance(plainText);
  speechUtterance.lang = 'ja-JP';
  speechUtterance.rate = 1.0;
  speechUtterance.onend = () => {
    btnSpeak.hidden = false;
    btnStop.hidden = true;
  };

  window.speechSynthesis.speak(speechUtterance);
  btnSpeak.hidden = true;
  btnStop.hidden = false;
});

btnStop.addEventListener('click', () => {
  window.speechSynthesis.cancel();
  btnSpeak.hidden = false;
  btnStop.hidden = true;
});

// --- コピー ---
btnCopy.addEventListener('click', async () => {
  if (!currentMarkdown) return;
  try {
    await navigator.clipboard.writeText(currentMarkdown);
    btnCopy.title = 'コピーしました！';
    setTimeout(() => { btnCopy.title = 'Markdownをコピー'; }, 2000);
  } catch {
    alert('コピーに失敗しました');
  }
});

// --- storageの変化を監視してジョブを受け取る ---
chrome.storage.onChanged.addListener((changes) => {
  if (changes.pendingJob?.newValue) {
    const job = changes.pendingJob.newValue;
    if (Date.now() - job.timestamp > 5000) return; // 5秒以上古いジョブは無視
    processPdf(job);
  }
});

// Side Panel表示時点でpendingJobが既にあれば即処理
chrome.storage.local.get('pendingJob').then(({ pendingJob }) => {
  if (pendingJob && Date.now() - pendingJob.timestamp < 5000) {
    processPdf(pendingJob);
  }
});

// 初期状態
showState('idle');
