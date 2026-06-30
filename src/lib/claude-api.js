// claude-api.js
// Anthropic APIを使ったPDFページ解析・Markdown化

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `あなたはPDFページの内容を忠実にMarkdown化するアシスタントです。

## 絶対的なルール
- **要約・省略・言い換えをしてはならない。** ページに存在するすべての文章・情報を一言一句そのまま出力すること
- テキストレイヤーが提供されている場合、そのテキストを**そのまま**使用すること（書き換え・要約禁止）
- ページ画像は、文書の構造（見出し階層・段落・リスト・表の有無・レイアウト）を判断するために使用する
- 出力はMarkdownのみ。前置きや説明文は不要

## 構造化のルール
- 見出しはフォントサイズ・太さ・配置から階層を判断し、\`#\` \`##\` \`###\` で表現する
- 表はMarkdown表形式で完全に再現する（セル内容も省略しない）
- 箇条書き・番号リストは元の構造を保持する
- 画像・図・グラフ・アイコン等が含まれる場合は \`[画像: （内容の詳細な説明）]\` の形式で記述する
- 図・グラフ内の数値やテキストはOCRしてそのまま含める
- ページ装飾（罫線・区切り等）は \`---\` で表現する`;

/**
 * PDFページをAIで解析してMarkdown化する
 * @param {string} apiKey
 * @param {object} pageData - pdf-processorが返したページデータ
 * @param {string} rawText - テキストレイヤーの生テキスト
 * @returns {Promise<{markdown: string}>}
 */
export async function analyzePageWithAI(apiKey, pageData, rawText) {
  const { pageImageBase64, hasTextLayer, images, pageNum } = pageData;
  const imgCount = images.reduce((s, img) => s + (img.count || 0), 0);

  const userContent = [];

  userContent.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: pageImageBase64,
    },
  });

  let instruction = `これはPDFの${pageNum}ページ目の画像です。画像からすべてのテキストを正確に読み取ってMarkdown化してください。\n\n`;

  if (hasTextLayer && rawText.trim()) {
    instruction += `以下はPDFのテキストレイヤーから取得した補助情報です。日本語が欠落している場合があるため、テキストの読み取りは必ず画像を優先してください。英数字・記号・コード等の正確な表記の確認にのみ使用してください：\n\`\`\`\n${rawText.slice(0, 4000)}\n\`\`\`\n\n`;
  }

  if (imgCount > 0) {
    instruction += `ページ内に${imgCount}個の画像・図版が含まれています。それぞれを [画像: （内容の説明）] 形式で説明してください。\n\n`;
  }

  instruction += 'このページを完全にMarkdown化してください。';

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
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API エラー: ${response.status} ${err?.error?.message || ''}`);
  }

  const data = await response.json();
  const markdown = data.content?.find((c) => c.type === 'text')?.text || '';

  return { markdown };
}
