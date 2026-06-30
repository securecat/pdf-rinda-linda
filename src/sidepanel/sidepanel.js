// sidepanel.js
import { extractPdfData } from '../lib/pdf-processor.js';
import { analyzePageWithAI } from '../lib/claude-api.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let currentMarkdown = '';
let speechUtterance = null;

const progressPanel = $('#progress-panel');
const progressMessage = $('#progress-message');
const errorPanel = $('#error-panel');
const errorMessage = $('#error-message');
const idlePanel = $('#idle-panel');
const outputPanel = $('#output-panel');
const mdOutput = $('#md-output');
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

// --- ページヘッダー（コスト表示） ---
function buildPageHeader(pageData, isFirst) {
  const { pageNum, hasTextLayer, images } = pageData;

  const breakdown = [];
  let cost = 0;

  if (!hasTextLayer) {
    cost += 30;
    breakdown.push({ delta: 30, reason: 'テキストレイヤーなし', warn: true });
  }
  const imgCount = images.reduce((s, img) => s + (img.count || 0), 0);
  if (imgCount > 0) {
    const delta = imgCount * 5;
    cost += delta;
    breakdown.push({ delta, reason: `画像 ${imgCount}枚`, warn: false });
  }
  const noAltCount = images.filter((img) => !img.altText).length;
  if (noAltCount > 0) {
    const delta = noAltCount * 10;
    cost += delta;
    breakdown.push({ delta, reason: `alt無し ${noAltCount}枚`, warn: true });
  }

  const level = cost >= 60 ? 'high' : cost >= 25 ? 'medium' : '';
  const tagsHtml = breakdown.map((b) =>
    `<span class="cost-tag ${b.warn ? 'cost-tag--warn' : ''}">+${b.delta} ${b.reason}</span>`
  ).join('');

  const sep = isFirst ? '' : '<div class="page-sep" aria-hidden="true"></div>';

  return `${sep}<div class="page-header">
    <div class="page-header-top">
      <span class="page-header-num">ページ ${pageNum}</span>
      <div class="page-header-cost-area">
        <span class="page-cost-label">コスト</span>
        <span class="page-cost-value" data-level="${level}">${cost}</span>
      </div>
    </div>
    ${tagsHtml ? `<div class="page-cost-tags">${tagsHtml}</div>` : ''}
  </div>`;
}

// --- Markdownレンダリング ---
function renderMarkdown(md) {
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
  const { lastProcessedTs } = await chrome.storage.local.get('lastProcessedTs');
  if (lastProcessedTs === payload.timestamp) return;
  await chrome.storage.local.set({ lastProcessedTs: payload.timestamp });

  const { url, pageRange } = payload;
  currentMarkdown = '';
  mdOutput.innerHTML = '';
  btnSpeak.disabled = true;
  btnCopy.disabled = true;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showError('APIキーが設定されていません。設定画面からAnthropicのAPIキーを登録してください。');
    return;
  }

  try {
    const { pages } = await extractPdfData(url, pageRange, (msg) => {
      setProgress(msg);
    });

    showState('output');
    const allMarkdownParts = [];

    for (let i = 0; i < pages.length; i++) {
      const pageData = pages[i];
      const { pageNum, rawText } = pageData;

      mdOutput.insertAdjacentHTML('beforeend', buildPageHeader(pageData, i === 0));

      setProgress(`ページ ${pageNum} をAI解析中…`);
      showState('output');

      try {
        const result = await analyzePageWithAI(apiKey, pageData, rawText);
        allMarkdownParts.push(result.markdown);
        mdOutput.insertAdjacentHTML('beforeend', renderMarkdown(result.markdown));
      } catch (apiErr) {
        console.error(`ページ ${pageNum} AI解析エラー:`, apiErr);
        mdOutput.insertAdjacentHTML(
          'beforeend',
          `<p class="page-error">ページ ${pageNum} の解析に失敗しました: ${esc(apiErr.message)}</p>`
        );
        allMarkdownParts.push('');
      }
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
    if (Date.now() - job.timestamp > 5000) return;
    processPdf(job);
  }
});

chrome.storage.local.get('pendingJob').then(({ pendingJob }) => {
  if (pendingJob && Date.now() - pendingJob.timestamp < 5000) {
    processPdf(pendingJob);
  }
});

showState('idle');
