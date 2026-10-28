import * as FileSystem from 'expo-file-system/legacy';
import FaceDetection from './faceDetection';

// Still-photo liveness fallback for Expo Go (real builds use LiveFaceCamera's
// frame processor): hold a face for HOLD_FRAMES reads, then detect a blink.
// Frames are captured at reduced size, and the next one while the current is analyzed.

const MAX_CAPTURE_SIDE = 1280; // plenty for the server's 112x112 aligned face crop
const MIN_CAPTURE_SIDE = 480;

const HOLD_FRAMES = 2; // consecutive good frames before moving on to the blink
const HOLD_TIMEOUT_MS = 10000;
const BLINK_TIMEOUT_MS = 7000;
export const EYES_OPEN_THRESHOLD = 0.6; // ML Kit eyeOpenProbability above this counts as "open"
export const EYES_CLOSED_THRESHOLD = 0.4; // below this counts as "closed" (a fast blink caught mid-way, or blurred, often reads 0.2-0.4)
const MAX_FACE_DROPOUT = 5; // consecutive misses during the blink before giving up on this attempt
const MIN_FACE_WIDTH_RATIO = 0.2; // face width / frame's short side -- smaller than this is too far for a reliable match
const MAX_HEAD_TURN_DEG = 22; // yaw/roll beyond this isn't "looking at the camera"

const DETECT_OPTIONS = {
  performanceMode: 'fast',
  landmarkMode: 'none',
  contourMode: 'none',
  classificationMode: 'all', // needed for leftEyeOpenProbability / rightEyeOpenProbability
  minFaceSize: 0.12,
};

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function discardPhoto(photo) {
  if (photo?.uri) FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});
}

// Largest picture size within MIN/MAX_CAPTURE_SIDE, or undefined.
export async function choosePictureSize(camera) {
  try {
    const sizes = await camera.getAvailablePictureSizesAsync();
    let best;
    (sizes || []).forEach((s) => {
      const m = /^(\d+)x(\d+)$/.exec(s);
      if (!m) return;
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (Math.max(w, h) > MAX_CAPTURE_SIDE || Math.min(w, h) < MIN_CAPTURE_SIDE) return;
      if (!best || w * h > best.area) best = { size: s, area: w * h };
    });
    return best?.size;
  } catch (err) {
    return undefined;
  }
}

// Fast capture for analysis: no processing pass and no shutter sound.
// Resolves to null instead of throwing (e.g. camera not ready yet).
async function grabFrame(camera) {
  try {
    return await camera.takePictureAsync({ skipProcessing: true, shutterSound: false, base64: false, exif: false });
  } catch (err) {
    return null;
  }
}

// The largest detected face -- with someone else in the background,
// faces[0] isn't necessarily the person holding the phone.
async function detectMainFace(uri) {
  let faces = [];
  try {
    faces = await FaceDetection.detect(uri, DETECT_OPTIONS);
  } catch (err) {
    faces = [];
  }
  if (!faces || faces.length === 0) return null;
  const area = (f) => (f.frame ? f.frame.width * f.frame.height : 0);
  return faces.reduce((a, b) => (area(b) > area(a) ? b : a));
}

// null when the face is usable, otherwise 'far' or 'turned'. Checks are
// skipped when ML Kit (or the Expo Go stub) doesn't report the values.
export function faceIssue(face, photo) {
  const shortSide = Math.min(photo.width || 0, photo.height || 0);
  if (face.frame && shortSide > 0 && face.frame.width / shortSide < MIN_FACE_WIDTH_RATIO) return 'far';
  const yaw = Math.abs(face.rotationY || 0);
  const roll = Math.abs(face.rotationZ || 0);
  if (yaw > MAX_HEAD_TURN_DEG || roll > MAX_HEAD_TURN_DEG) return 'turned';
  return null;
}

export function eyeOpenness(face) {
  const { leftEyeOpenProbability: left, rightEyeOpenProbability: right } = face;
  if (left == null || right == null) return null;
  return (left + right) / 2;
}

// One hold-then-blink attempt.
// Resolves { ok: true, photo } or { ok: false, reason: 'cancelled' | 'no-face' | 'far' | 'turned' | 'blink' }.
export async function runLivenessAttempt({ camera, isActive, onStatus }) {
  let phase = 'hold';
  let deadline = Date.now() + HOLD_TIMEOUT_MS;
  let holdStreak = 0;
  let dropout = 0;
  let eyesClosed = false;
  let lastHint = null;
  let pending = grabFrame(camera);

  try {
    while (true) {
      if (!isActive()) return { ok: false, reason: 'cancelled' };
      if (Date.now() > deadline) {
        if (phase === 'blink') return { ok: false, reason: 'blink' };
        return { ok: false, reason: lastHint || 'no-face' };
      }

      const photo = await pending;
      pending = null;
      if (!isActive()) {
        discardPhoto(photo);
        return { ok: false, reason: 'cancelled' };
      }
      // Start capturing the next frame while this one is analyzed.
      pending = grabFrame(camera);
      if (!photo) {
        await wait(100);
        continue;
      }

      const face = await detectMainFace(photo.uri);
      const hint = face ? faceIssue(face, photo) : null;
      if (face) lastHint = hint;

      if (phase === 'hold') {
        holdStreak = face && !hint ? holdStreak + 1 : 0;
        if (holdStreak >= HOLD_FRAMES) {
          phase = 'blink';
          deadline = Date.now() + BLINK_TIMEOUT_MS;
        }
      } else if (!face) {
        dropout += 1;
        if (dropout >= MAX_FACE_DROPOUT) {
          discardPhoto(photo);
          return { ok: false, reason: 'blink' };
        }
      } else {
        dropout = 0;
        const openness = eyeOpenness(face);
        if (openness != null) {
          if (!eyesClosed && openness < EYES_CLOSED_THRESHOLD) {
            eyesClosed = true;
          } else if (eyesClosed && openness > EYES_OPEN_THRESHOLD && !hint) {
            onStatus?.({ phase, faceDetected: true, hint: null, eyesClosed: false });
            return { ok: true, photo };
          }
        }
      }

      onStatus?.({ phase, faceDetected: !!face, hint, eyesClosed });
      discardPhoto(photo);
    }
  } finally {
    // Let an in-flight capture finish before handing the camera back, so a
    // follow-up takePictureAsync doesn't collide with it.
    if (pending) discardPhoto(await pending);
  }
}

// Message for a failed attempt, matching what went wrong.
export function livenessFailureMessage(reason) {
  switch (reason) {
    case 'blink':
      return "Couldn't confirm a blink. Keep your face in the frame and blink once when prompted, then try again.";
    case 'far':
      return 'Your face is too far from the camera. Hold the phone closer so your face fills the oval, then try again.';
    case 'capture':
      return "Couldn't capture your selfie. Please try again.";
    case 'turned':
      return 'Please look straight at the camera (don’t tilt or turn your head), then try again.';
    default:
      return "Couldn't detect your face. Make sure your face is centered and well-lit, then try again.";
  }
}

// Live prompt under the camera while an attempt is running.
export function livenessCaption({ phase, faceDetected, hint, eyesClosed }) {
  if (phase === 'blink') return eyesClosed ? 'Great — now open your eyes' : 'Now blink once';
  if (!faceDetected) return 'Center your face in the frame';
  if (hint === 'far') return 'Move a little closer';
  if (hint === 'turned') return 'Look straight at the camera';
  return 'Hold still and look at the camera';
}
