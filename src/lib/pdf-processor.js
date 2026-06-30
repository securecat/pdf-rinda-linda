// pdf-processor.js
// PDF.jsを使ってPDFからテキスト・画像を抽出するコアロジック

import * as pdfjsLib from '../lib/pdf.min.mjs';

// workerの場所を指定（web_accessible_resourcesで許可済み）
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/lib/pdf.worker.min.mjs');

/**
 * PDFを読み込んで各ページのデータを抽出する
 * @param {string} url - PDFのURL
 * @param {{ mode: string, page?: number, from?: number, to?: number }} pageRange
 * @param {function} onProgress - 進捗コールバック (message: string)
 * @returns {Promise<PageData[]>}
 */
export async function extractPdfData(url, pageRange, onProgress = () => {}) {
  onProgress('PDFを読み込んでいます…');

  // PDFをArrayBufferとして取得
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDFの取得に失敗しました: ${response.status}`);
  const buffer = await response.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;

  // 対象ページ番号リストを決定
  let targetPages;
  if (pageRange.mode === 'all') {
    targetPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else if (pageRange.mode === 'single') {
    const p = Math.min(Math.max(pageRange.page, 1), totalPages);
    targetPages = [p];
  } else {
    const from = Math.min(Math.max(pageRange.from, 1), totalPages);
    const to = Math.min(Math.max(pageRange.to, 1), totalPages);
    targetPages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  onProgress(`全${totalPages}ページ中 ${targetPages.length}ページを処理します…`);

  const results = [];

  for (let i = 0; i < targetPages.length; i++) {
    const pageNum = targetPages[i];
    onProgress(`ページ ${pageNum} / ${totalPages} を解析中…`);

    const pageData = await extractPageData(pdf, pageNum);
    results.push(pageData);
  }

  return { pages: results, totalPages };
}

/**
 * 1ページ分のデータを抽出
 */
async function extractPageData(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);

  // 1. テキストレイヤー抽出
  const textContent = await page.getTextContent();
  const textItems = textContent.items.map((item) => ({
    str: item.str,
    // 変換行列からフォントサイズを推定（絶対値）
    fontSize: Math.abs(item.transform[3]),
    x: item.transform[4],
    y: item.transform[5],
    hasEOL: item.hasEOL,
  }));

  // テキストレイヤーを文字列に組み立て
  const rawText = assembleText(textItems);
  const hasTextLayer = rawText.trim().length > 0;

  // 2. 構造情報（見出しタグ等）
  // PDF.jsのgetStructTree()でタグ情報を取得試行
  let structTree = null;
  try {
    structTree = await pdf.getMarkInfo();
  } catch {
    // タグ付きPDFでない場合はnull
  }

  // 3. 画像をCanvasでキャプチャ
  const viewport = page.getViewport({ scale: 3.0 }); // 高解像度
  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');

  await page.render({ canvasContext: context, viewport }).promise;

  // 横長ページ（見開き等）は左右分割して各半分を高解像度で渡す
  const isWide = viewport.width > viewport.height * 1.2;
  let pageImageBase64 = null;
  let sectionImages = [];

  if (isWide) {
    const halfW = Math.floor(viewport.width / 2);
    const rightW = viewport.width - halfW;

    const leftCanvas = new OffscreenCanvas(halfW, viewport.height);
    leftCanvas.getContext('2d').drawImage(canvas, 0, 0, halfW, viewport.height, 0, 0, halfW, viewport.height);
    const leftBlob = await leftCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });

    const rightCanvas = new OffscreenCanvas(rightW, viewport.height);
    rightCanvas.getContext('2d').drawImage(canvas, halfW, 0, rightW, viewport.height, 0, 0, rightW, viewport.height);
    const rightBlob = await rightCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });

    sectionImages = [
      { base64: await blobToBase64(leftBlob), label: '左半分' },
      { base64: await blobToBase64(rightBlob), label: '右半分' },
    ];
  } else {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    pageImageBase64 = await blobToBase64(blob);
  }

  // 4. 個別画像オブジェクトとそのalt属性を取得
  const operatorList = await page.getOperatorList();
  const images = await extractImages(page, operatorList, canvas, context, viewport);

  // 5. アクセスコスト計算（基本部分）
  const baseCost = calcBaseCost({ hasTextLayer, images });

  return {
    pageNum,
    rawText,
    hasTextLayer,
    textItems,
    structTree,
    pageImageBase64,
    sectionImages,
    images,
    baseCost,
  };
}

/**
 * テキストアイテムを読み順に結合
 */
function assembleText(items) {
  if (items.length === 0) return '';

  let result = '';
  let prevY = null;
  const Y_THRESHOLD = 4;

  for (const item of items) {
    if (prevY !== null && Math.abs(item.y - prevY) > Y_THRESHOLD) {
      result += '\n';
    } else if (result.length > 0 && !result.endsWith(' ') && !result.endsWith('\n')) {
      result += ' ';
    }
    result += item.str;
    if (item.hasEOL) result += '\n';
    prevY = item.y;
  }

  return result;
}

/**
 * ページから個別画像を抽出してbase64化
 */
async function extractImages(page, operatorList, _canvas, _ctx, viewport) {
  const images = [];
  const { OPS } = await import('../lib/pdf.min.mjs');

  // ページのリソース（XObjectなど）から画像を探す
  try {
    const resources = await page.commonObjs;
    // PDF.jsのAPIでは画像の直接抽出は限定的なため、
    // ページ全体画像でカバーしつつ、画像の存在数だけカウントする
    let imgCount = 0;
    for (let j = 0; j < operatorList.fnArray.length; j++) {
      // paintImageXObject = 85 (PDF.js OPS値)
      if (operatorList.fnArray[j] === 85) {
        imgCount++;
      }
    }
    if (imgCount > 0) {
      images.push({ count: imgCount, altText: null });
    }
  } catch {
    // 画像取得失敗時はスキップ
  }

  return images;
}

/**
 * 基本アクセスコスト計算（APIなし段階）
 */
function calcBaseCost({ hasTextLayer, images }) {
  let cost = 0;
  if (!hasTextLayer) cost += 30; // テキストレイヤーなし → OCR必須
  const imgCount = images.reduce((s, img) => s + (img.count || 0), 0);
  if (imgCount > 0) cost += imgCount * 5; // 画像1枚につき+5
  images.forEach((img) => {
    if (!img.altText) cost += 10; // alt無し画像1枚につき+10
  });
  return cost;
}

/**
 * BlobをBase64文字列に変換
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
