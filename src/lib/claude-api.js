// claude-api.js
// Anthropic APIを使った画像解析・Markdown化

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

/**
 * ページ画像をAnthropicに送ってOCR・説明・Markdown化を一括処理
 * @param {string} apiKey
 * @param {object} pageData - pdf-processorが返したページデータ
 * @param {string} rawTextFromLayer - テキストレイヤーの生テキスト（参考情報として渡す）
 * @returns {Promise<{markdown: string, costDelta: number}>}
 */
export async function analyzePageWithAI(apiKey, pageData, rawTextFromLayer) {
  const { pageImageBase64, hasTextLayer, images, pageNum } = pageData;
  const imgCount = images.reduce((s, img) => s + (img.count || 0), 0);

  const systemPrompt = `あなたはPDFページの内容を正確にMarkdown化するアシスタントです。
以下のルールに従ってください：
- 見出しは # ## ### で表現する（元PDFのフォントサイズ・階層を尊重）
- 表はMarkdown表形式で再現する
- 画像・図版が含まれる場合は [画像: 〜の図] のように内容を説明する
- 画像内のテキスト（OCR）はそのままテキストとして含める
- 箇条書き・番号リストは元の構造を保持する
- テキストレイヤー情報が提供されている場合は優先的に使用し、視覚情報で補完する
- 出力はMarkdownのみ。前置きや説明文は不要。`;

  const userContent = [];

  // ページ画像を送る
  userContent.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: pageImageBase64,
    },
  });

  // テキストレイヤーがある場合は参考として渡す
  let textHint = `これはPDFの${pageNum}ページ目です。`;
  if (hasTextLayer && rawTextFromLayer.trim()) {
    textHint += `\n\nPDFのテキストレイヤーから取得したテキスト（参考）:\n\`\`\`\n${rawTextFromLayer.slice(0, 3000)}\n\`\`\``;
  } else {
    textHint += '\nこのページにはテキストレイヤーがありません。画像からOCRして内容を抽出してください。';
  }

  if (imgCount > 0) {
    textHint += `\nページ内に${imgCount}個の画像・図版が含まれています。それぞれの内容を説明してください。`;
  }

  textHint += '\n\nこのページの内容を完全にMarkdown化してください。';

  userContent.push({ type: 'text', text: textHint });

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API エラー: ${response.status} ${err?.error?.message || ''}`);
  }

  const data = await response.json();
  const markdown = data.content?.find((c) => c.type === 'text')?.text || '';

  // トークン使用量からアクセスコスト追加分を計算
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  // 画像トークンが多い = アクセシビリティが低かった証拠 → コスト換算
  // テキストレイヤーがあれば減点なし、なければ画像トークン比でコスト加算
  let costDelta = 0;
  if (!hasTextLayer) {
    costDelta += Math.min(Math.round(inputTokens / 500), 40);
  }
  if (imgCount > 0) {
    costDelta += imgCount * 8;
  }

  return { markdown, costDelta, usage: { inputTokens, outputTokens } };
}

/**
 * テキストレイヤーのみでMarkdown化（APIキー不要の基本モード）
 * @param {string} rawText
 * @param {object[]} textItems
 * @returns {string}
 */
export function textLayerToMarkdown(rawText, textItems) {
  if (!rawText.trim()) return '';

  // フォントサイズでざっくり見出し推定
  const sizes = textItems.map((i) => i.fontSize).filter(Boolean);
  const maxSize = Math.max(...sizes, 0);
  const lines = rawText.split('\n');

  const mdLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    // 対応するtextItemを探す
    const matchItem = textItems.find((item) => item.str && trimmed.startsWith(item.str.slice(0, 10)));
    const fontSize = matchItem?.fontSize || 0;

    if (fontSize > 0 && maxSize > 0) {
      const ratio = fontSize / maxSize;
      if (ratio > 0.85) return `# ${trimmed}`;
      if (ratio > 0.7) return `## ${trimmed}`;
      if (ratio > 0.55) return `### ${trimmed}`;
    }

    return trimmed;
  });

  return mdLines.filter((l) => l !== null).join('\n');
}
