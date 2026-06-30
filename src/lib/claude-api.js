// claude-api.js
// Anthropic APIを使ったPDFページ解析・Markdown化

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `あなたはPDFページの内容を忠実にMarkdown化するアシスタントです。

## 最重要ルール
- **要約・省略・言い換えをしてはならない。** 特に「〜について紹介します」「〜が発足しました」のような1文要約は絶対禁止。元の文章を一字一句そのまま出力すること
- **テキストは必ず画像から直接OCRすること。** 日本語PDFのテキストレイヤーはCMap問題で文字化けしているため信用できない
- 補助情報として渡されたASCIIテキストは、英数字・記号・ページ番号等の確認にのみ使うこと。日本語の参照には絶対に使わないこと
- 出力はMarkdownのみ。前置きや説明文は不要

## テキストの読み取り範囲（重要）
- **装飾的な横線（—）の直後に続くテキストを省略しないこと。** 横線はデザイン上の区切りであり、その後にある大きな文字のスローガン・宣言文・説明文も必ず書き出すこと
- **●・▶・■等の記号で始まる色付き見出しもそのまま転写すること。** 記号と見出し文字を自分で別の表現に置き換えないこと
- **文字の色に関わらず**すべて読み取ること。青・白・灰色・橙色など色付きの見出しや文字も必ず含める
- 大きなキャッチコピー・装飾フォントの文字もすべて転写すること
- 段落の途中で切らず、必ず最後の文字まで書き出すこと
- 複数段レイアウト（2段組など）は読み順を判断して上から順に出力すること
- テキストが小さくても必ず読み取ること。省略・「など」による代替は禁止

## 構造化のルール
- 見出しはフォントサイズ・太さ・配置から階層を判断し、\`#\` \`##\` \`###\` で表現する
- 表はMarkdown表形式で完全に再現する（セル内容も省略しない）
- 箇条書き・番号リストは元の構造を保持する
- 写真・イラスト・図版等は \`[画像: （1文で内容を簡潔に説明）]\` の形式で記述する（装飾イラストは短く）
- 図・グラフ内の数値やテキストはOCRしてそのまま含める
- ページ装飾（罫線・区切り等）は \`—\` で表現する（\`---\` はMarkdownの水平線として解釈されるため**使用禁止**）`;

/**
 * PDFページをAIで解析してMarkdown化する
 * @param {string} apiKey
 * @param {object} pageData - pdf-processorが返したページデータ
 * @param {string} rawText - テキストレイヤーの生テキスト
 * @returns {Promise<{markdown: string}>}
 */
export async function analyzePageWithAI(apiKey, pageData, rawText) {
  const { pageImageBase64, sectionImages, hasTextLayer, pageNum } = pageData;

  if (sectionImages && sectionImages.length > 0) {
    // 見開きページ: 左右を個別のAPI呼び出しに分けて各半分に集中させる
    const markdowns = [];
    for (const section of sectionImages) {
      const md = await callApi(
        apiKey,
        section.base64,
        `${pageNum}ページ目の${section.label}`,
        hasTextLayer,
        rawText,
      );
      markdowns.push(md);
    }
    return { markdown: markdowns.join('\n\n') };
  }

  const markdown = await callApi(apiKey, pageImageBase64, `${pageNum}ページ目`, hasTextLayer, rawText);
  return { markdown };
}

async function callApi(apiKey, imageBase64, pageLabel, hasTextLayer, rawText) {
  const userContent = [];

  userContent.push({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
  });

  let instruction = `これはPDFの${pageLabel}の画像です。\n\n`;
  instruction += `【重要】日本語テキストはすべて画像から直接OCRしてください。以下に特に注意すること：\n- 装飾的な横線（—）の直後にある大きなテキスト（スローガン・宣言文等）も必ず書き出す\n- ●や▶で始まる色付き見出しはその記号と文字を正確にそのまま転写する\n- 各段落は要約せず一字一句すべて書き出す（最初の段落も含む）\n- ✓や→などの記号をテキストの代わりに出力することは禁止\n\n`;

  if (hasTextLayer && rawText.trim()) {
    const asciiText = rawText.replace(/[^\x00-\x7F\n\r]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (asciiText) {
      instruction += `補助情報（英数字・記号・ページ番号の確認用。日本語の参照には使わないこと）：\n\`\`\`\n${asciiText.slice(0, 1500)}\n\`\`\`\n\n`;
    }
  }

  instruction += 'このページを完全にMarkdown化してください。装飾イラストの説明は1文で簡潔に。本文テキストの転写を最優先してください。';

  userContent.push({ type: 'text', text: instruction });

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API エラー: ${response.status} ${err?.error?.message || ''}`);
  }

  const data = await response.json();
  return data.content?.find((c) => c.type === 'text')?.text || '';
}
