const Tesseract = require('tesseract.js');
const path = require('path');

const TESSDATA_PATH = path.join(__dirname, '..', 'tessdata');

/**
 * Runs Tesseract on an image using the bundled tessdata (works offline).
 * Returns { text, confidence }.
 */
async function extractText(imagePath) {
  try {
    const { data } = await Tesseract.recognize(imagePath, 'eng', {
      langPath: TESSDATA_PATH,
      gzip: true,
      cacheMethod: 'none',
      logger: () => {} // silence per-tile progress logs
    });
    return {
      text: data.text || '',
      confidence: data.confidence || 0 // 0-100
    };
  } catch (err) {
    console.error('OCR extraction failed:', err.message);
    return { text: '', confidence: 0 };
  }
}

/**
 * Extracts only the employee ID number; name and position come from the
 * employees table.
 */
function parseIdCard(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer digits near the "EMPLOYEE NUMBER" label, then a letter-prefixed code
  // (E001), then any standalone 6-12 digit run.
  let employeeCode = null;
  const labelIdx = lines.findIndex((l) => /employee\s*number/i.test(l));
  if (labelIdx !== -1) {
    for (let i = labelIdx; i >= Math.max(0, labelIdx - 2); i--) {
      const m = lines[i].match(/\b(\d{6,12})\b/);
      if (m) { employeeCode = m[1]; break; }
    }
  }
  if (!employeeCode) {
    const letterCode = rawText.match(/\b([A-Z]{1,4}-?\d{2,6})\b/);
    if (letterCode) employeeCode = letterCode[1].replace('-', '');
  }
  if (!employeeCode) {
    const numericCode = rawText.match(/\b(\d{6,12})\b/);
    if (numericCode) employeeCode = numericCode[1];
  }

  return { employeeCode, lines };
}

module.exports = { extractText, parseIdCard };
