const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/config');

// InsightFace pipeline: SCRFD detects the face and 5 landmarks, the face is
// aligned to the 112x112 ArcFace template, then the recognizer embeds it.
// Model paths: config/config.js.

// Loaded lazily so the server boots even without the model files.
let ort = null;

// Disabling the CPU memory arena roughly halves memory use with no measurable slowdown.
const SESSION_OPTIONS = { enableCpuMemArena: false, enableMemPattern: false };
let detectorSessionPromise = null;
let recognizerSessionPromise = null;

function getDetectorSession() {
  if (detectorSessionPromise) return detectorSessionPromise;
  detectorSessionPromise = (async () => {
    const modelPath = config.face.detectorModelPath;
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `InsightFace detector model not found at ${modelPath}. Download "det_10g.onnx" from the InsightFace ` +
        '"buffalo_l" model pack (https://github.com/deepinsight/insightface/tree/master/model_zoo) and place ' +
        'it there, or set FACE_DETECTOR_MODEL_PATH in .env to its location.'
      );
    }
    ort = ort || require('onnxruntime-node');
    return ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  })();
  return detectorSessionPromise;
}

function getRecognizerSession() {
  if (recognizerSessionPromise) return recognizerSessionPromise;
  recognizerSessionPromise = (async () => {
    const modelPath = config.face.modelPath;
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `InsightFace recognizer model not found at ${modelPath}. Download "w600k_r50.onnx" from the InsightFace ` +
        '"buffalo_l" model pack (https://github.com/deepinsight/insightface/tree/master/model_zoo) and place ' +
        'it there, or set FACE_MODEL_PATH in .env to its location.'
      );
    }
    ort = ort || require('onnxruntime-node');
    return ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  })();
  return recognizerSessionPromise;
}

const FEAT_STRIDE_FPN = [8, 16, 32];
const NUM_ANCHORS = 2;

// Faces end up 112x112, so large photos are downscaled on decode.
const MAX_DECODE_SIDE = 1600;

/**
 * Decodes once to an upright RGB buffer. rotate() applies EXIF orientation,
 * which phone cameras often use instead of rotating the pixels.
 */
async function loadImage(imagePath) {
  const { data, info } = await sharp(imagePath)
    .rotate()
    .resize(MAX_DECODE_SIDE, MAX_DECODE_SIDE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Letterboxes to the detector input size at the top-left (as InsightFace does)
 * and returns a normalized NCHW tensor.
 */
async function preprocessDetectorInput(image) {
  const inputSize = config.face.detectorInputSize;
  const origWidth = image.width;
  const origHeight = image.height;

  const imRatio = origHeight / origWidth;
  let newWidth;
  let newHeight;
  if (imRatio > 1) {
    newHeight = inputSize;
    newWidth = Math.max(1, Math.round(newHeight / imRatio));
  } else {
    newWidth = inputSize;
    newHeight = Math.max(1, Math.round(newWidth * imRatio));
  }
  const detScale = newHeight / origHeight; // == newWidth / origWidth

  const { data } = await sharp(image.data, { raw: { width: origWidth, height: origHeight, channels: 3 } })
    .resize(newWidth, newHeight, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = inputSize * inputSize;
  const chw = new Float32Array(pixelCount * 3); // zero-initialized -> black padding
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcIdx = (y * newWidth + x) * 3;
      const dstIdx = y * inputSize + x;
      chw[dstIdx] = (data[srcIdx] - 127.5) / 128.0;
      chw[pixelCount + dstIdx] = (data[srcIdx + 1] - 127.5) / 128.0;
      chw[pixelCount * 2 + dstIdx] = (data[srcIdx + 2] - 127.5) / 128.0;
    }
  }

  return { tensorData: chw, inputSize, detScale, origWidth, origHeight };
}

/** Runs SCRFD and decodes boxes, landmarks and scores in detector-input space. */
async function runDetector(tensorData, inputSize) {
  const session = await getDetectorSession();
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);
  const results = await session.run({ [inputName]: tensor });

  // Outputs are grouped by type across strides: [scores x3, boxes x3, kps x3].
  const names = session.outputNames;
  const fmc = FEAT_STRIDE_FPN.length; // 3
  const useKps = names.length >= fmc * 3;

  const boxes = [];
  const scores = [];
  const kpss = [];

  for (let idx = 0; idx < fmc; idx++) {
    const stride = FEAT_STRIDE_FPN[idx];
    const strideScores = results[names[idx]].data;
    const bboxPreds = results[names[idx + fmc]].data;
    const kpsPreds = useKps ? results[names[idx + fmc * 2]].data : null;

    const height = Math.floor(inputSize / stride);
    const width = Math.floor(inputSize / stride);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        for (let a = 0; a < NUM_ANCHORS; a++) {
          const anchorIdx = (row * width + col) * NUM_ANCHORS + a;
          const score = strideScores[anchorIdx];
          if (score < config.face.detectorScoreThreshold) continue;

          const cx = col * stride;
          const cy = row * stride;

          const bOff = anchorIdx * 4;
          const dx1 = bboxPreds[bOff] * stride;
          const dy1 = bboxPreds[bOff + 1] * stride;
          const dx2 = bboxPreds[bOff + 2] * stride;
          const dy2 = bboxPreds[bOff + 3] * stride;
          boxes.push([cx - dx1, cy - dy1, cx + dx2, cy + dy2]);
          scores.push(score);

          if (useKps) {
            const kOff = anchorIdx * 10;
            const kps = [];
            for (let k = 0; k < 5; k++) {
              const px = cx + kpsPreds[kOff + k * 2] * stride;
              const py = cy + kpsPreds[kOff + k * 2 + 1] * stride;
              kps.push([px, py]);
            }
            kpss.push(kps);
          } else {
            kpss.push(null);
          }
        }
      }
    }
  }

  return { boxes, scores, kpss };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(boxes, scores, kpss, iouThreshold) {
  const order = scores.map((_, i) => i).sort((i, j) => scores[j] - scores[i]);
  const suppressed = new Array(boxes.length).fill(false);
  const kept = [];
  for (const i of order) {
    if (suppressed[i]) continue;
    kept.push({ box: boxes[i], score: scores[i], kps: kpss[i] });
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed[j] = true;
    }
  }
  return kept;
}

/** Returns the largest confident face as { score, box, kps }, or null. */
async function detectFace(imageOrPath) {
  const image = typeof imageOrPath === 'string' ? await loadImage(imageOrPath) : imageOrPath;
  const { tensorData, inputSize, detScale } = await preprocessDetectorInput(image);
  const { boxes, scores, kpss } = await runDetector(tensorData, inputSize);
  if (boxes.length === 0) return null;

  const detections = nms(boxes, scores, kpss, config.face.detectorNmsThreshold);
  if (detections.length === 0) return null;

  // Prefer the largest face (the one the camera was pointed at).
  detections.sort((a, b) => {
    const areaA = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
    const areaB = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
    return areaB - areaA;
  });
  const best = detections[0];

  return {
    score: best.score,
    box: best.box.map((v) => v / detScale),
    kps: best.kps ? best.kps.map(([x, y]) => [x / detScale, y / detScale]) : null,
  };
}

// InsightFace 112x112 template: eyes, nose tip, mouth corners.
const ARCFACE_DST_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform (scale + rotation + translation). Linear
 * in (a, b, tx, ty), so a 4x4 normal-equations solve is enough.
 */
function solveSimilarityTransform(srcPts, dstPts) {
  const ATA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const ATb = [0, 0, 0, 0];

  for (let i = 0; i < srcPts.length; i++) {
    const [sx, sy] = srcPts[i];
    const [dx, dy] = dstPts[i];
    const rowX = [sx, -sy, 1, 0]; // dst_x = a*sx - b*sy + tx
    const rowY = [sy, sx, 0, 1]; // dst_y = b*sx + a*sy + ty
    for (let r = 0; r < 4; r++) {
      ATb[r] += rowX[r] * dx + rowY[r] * dy;
      for (let c = 0; c < 4; c++) {
        ATA[r][c] += rowX[r] * rowX[c] + rowY[r] * rowY[c];
      }
    }
  }

  const [a, b, tx, ty] = solveLinearSystem(ATA, ATb);
  return { a, b, tx, ty };
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivot = M[col][col] || 1e-9;
    for (let c = col; c <= n; c++) M[col][c] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  return M.map((row) => row[n]);
}

/** Inverse-maps each output pixel into `src` with bilinear sampling. */
function warpAffine(src, srcW, srcH, transform, outW, outH) {
  const { a, b, tx, ty } = transform;
  const det = a * a + b * b || 1e-9;
  const out = new Uint8ClampedArray(outW * outH * 3); // defaults to black where the source doesn't cover

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const dx = ox - tx;
      const dy = oy - ty;
      // Inverse of the [[a,-b],[b,a]] rotation-scale block is (1/det)*[[a,b],[-b,a]].
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;
      if (sx < 0 || sy < 0 || sx > srcW - 1 || sy > srcH - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const outIdx = (oy * outW + ox) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * srcW + x0) * 3 + ch];
        const p10 = src[(y0 * srcW + x1) * 3 + ch];
        const p01 = src[(y1 * srcW + x0) * 3 + ch];
        const p11 = src[(y1 * srcW + x1) * 3 + ch];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[outIdx + ch] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}

function alignFace(image, kps) {
  const transform = solveSimilarityTransform(kps, ARCFACE_DST_112);
  const inputSize = config.face.inputSize;
  return warpAffine(image.data, image.width, image.height, transform, inputSize, inputSize);
}

async function embedAlignedFace(rawRgbBuffer) {
  const session = await getRecognizerSession();
  const inputSize = config.face.inputSize;
  const pixelCount = inputSize * inputSize;
  const chw = new Float32Array(pixelCount * 3);
  // Interleaved RGB to planar (NCHW).
  for (let i = 0; i < pixelCount; i++) {
    chw[i] = (rawRgbBuffer[i * 3] - 127.5) / 128.0;
    chw[pixelCount + i] = (rawRgbBuffer[i * 3 + 1] - 127.5) / 128.0;
    chw[pixelCount * 2 + i] = (rawRgbBuffer[i * 3 + 2] - 127.5) / 128.0;
  }

  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, inputSize, inputSize]);
  const results = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const raw = Array.from(results[outputName].data);

  // L2-normalize so cosine similarity is a dot product.
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** Detect, align and embed. Throws a user-facing error when no face is found. */
async function getEmbedding(imagePath) {
  const image = await loadImage(imagePath);
  const face = await detectFace(image);
  if (!face || !face.kps) {
    throw new Error(
      'No face was detected in the photo. Please retake it with your face centered, unobstructed, and well-lit.'
    );
  }
  const aligned = alignFace(image, face.kps);
  return embedAlignedFace(aligned);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/** Best candidate at or above the match threshold, or null. */
function findBestMatch(targetEmbedding, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(targetEmbedding, candidate.embedding);
    if (!best || similarity > best.similarity) {
      best = { employeeId: candidate.employeeId, similarity };
    }
  }
  if (!best || best.similarity < config.face.matchThreshold) return null;
  return best;
}

// Loads both models early so the first face request after a restart is fast.
function warmUp() {
  return Promise.all([getDetectorSession(), getRecognizerSession()]);
}

module.exports = {
  getEmbedding,
  warmUp,
  cosineSimilarity,
  findBestMatch
};
