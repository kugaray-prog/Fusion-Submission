import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { IS_EXPO_GO } from '../utils/expoGo';
import { CameraView } from 'expo-camera';
import {
  runLivenessAttempt, choosePictureSize, discardPhoto, faceIssue, eyeOpenness, wait,
  EYES_OPEN_THRESHOLD, EYES_CLOSED_THRESHOLD,
} from '../utils/faceCapture';

// Selfie camera with liveness (hold still, then blink). Uses VisionCamera + ML Kit
// in real builds, still-photo polling in Expo Go.
//   const result = await cameraRef.current.runLiveness();
//   // { ok: true, photoUri, video } | { ok: false, reason }


/* eslint-disable global-require */
const VisionCamera = IS_EXPO_GO ? null : require('react-native-vision-camera');
const FaceDetector = IS_EXPO_GO ? null : require('react-native-vision-camera-face-detector');
/* eslint-enable global-require */

const HOLD_MS = 150; // face usable (in frame, close enough, facing the camera) this long before the blink prompt
const MIN_FACE_MS = 150; // a blink only counts once the face has been usable at least this long
const HOLD_TIMEOUT_MS = 12000;
const BLINK_TIMEOUT_MS = 8000;
const FACE_LOST_MS = 800; // face gone this long during the blink -> back to the hold step
const MIN_VIDEO_SECONDS = 0.5; // very short clips can fail to finalize on some devices
const MAX_VIDEO_SECONDS = 30;

const sameStatus = (a, b) => a && b && a.phase === b.phase && a.faceDetected === b.faceDetected
  && a.hint === b.hint && a.eyesClosed === b.eyesClosed;

// Reads what the liveness check needs out of a detected (native) Face once,
// in the shape faceIssue()/eyeOpenness() expect.
function readFace(face) {
  const { bounds } = face;
  return {
    frame: { width: bounds.width, height: bounds.height },
    rotationY: face.yawAngle,
    rotationZ: face.rollAngle,
    leftEyeOpenProbability: face.leftEyeOpenProbability,
    rightEyeOpenProbability: face.rightEyeOpenProbability,
    frameWidth: face.frameWidth,
    frameHeight: face.frameHeight,
  };
}

const NativeLiveCamera = forwardRef(function NativeLiveCamera({ style, onReady, onStatus }, ref) {
  const device = VisionCamera.useCameraDevice('front');
  const cameraRef = useRef(null);
  const runRef = useRef(null); // the in-progress liveness attempt, if any
  const lastStatusRef = useRef(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const videoOutput = VisionCamera.useVideoOutput({
    targetResolution: VisionCamera.CommonResolutions.VGA_4_3,
    targetBitRate: 1500000,
    enableAudio: false,
    fileType: 'mp4',
  });
  // iOS can't snapshot the preview, so the selfie still comes from a photo output there.
  const photoOutput = VisionCamera.usePhotoOutput({
    targetResolution: VisionCamera.CommonResolutions.HD_4_3,
    containerFormat: 'jpeg', // not HEIC -- the server decodes it with sharp
    quality: 0.9,
    qualityPrioritization: 'speed',
  });

  const emitStatus = (status) => {
    if (sameStatus(status, lastStatusRef.current)) return;
    lastStatusRef.current = status;
    onStatusRef.current?.(status);
  };

  const handleFaces = (faces) => {
    if (!runRef.current) return;
    // Largest face = the person holding the phone, not someone behind them.
    let best = null;
    for (const f of faces) {
      const area = f.bounds.width * f.bounds.height;
      if (!best || area > best.area) best = { face: f, area };
    }
    const face = best ? readFace(best.face) : null;
    const photoLike = face ? { width: face.frameWidth, height: face.frameHeight } : null;
    const hint = face ? faceIssue(face, photoLike) : null;
    const run = runRef.current;
    if (run) run.onFrame(face, hint, Date.now()); // statuses are only reported during a liveness run
  };
  const handleFacesRef = useRef(handleFaces);
  handleFacesRef.current = handleFaces;

  // Created once: re-creating the output re-configures the camera session.
  const faceOutput = useMemo(() => FaceDetector.createFaceDetectorOutput({
    performanceMode: 'fast',
    runClassifications: true, // eye-open probabilities for the blink
    runLandmarks: false,
    runContours: false,
    minFaceSize: 0.15,
    cameraFacing: 'front',
    autoMode: false,
    outputResolution: 'preview',
    onFacesDetected: (faces) => handleFacesRef.current(faces),
    onError: () => {},
  }), []);

  const outputs = useMemo(
    () => (Platform.OS === 'ios' ? [faceOutput, videoOutput, photoOutput] : [faceOutput, videoOutput]),
    [faceOutput, videoOutput, photoOutput],
  );

  const captureStill = async () => {
    if (Platform.OS === 'android') {
      const snapshot = await cameraRef.current.takeSnapshot();
      // The preview is mirrored like a mirror; store the face the right way
      // round, the way every earlier (non-mirrored) registration photo is.
      const upright = await snapshot.mirrorHorizontallyAsync();
      const path = await upright.saveToTemporaryFileAsync('jpg', 90);
      return `file://${path}`;
    }
    const file = await photoOutput.capturePhotoToFile({ flashMode: 'off', enableShutterSound: false }, {});
    return `file://${file.filePath}`;
  };

  // Starts the video selfie. Never blocks or fails the liveness check -- the
  // still is what the server matches; the clip is supporting evidence.
  const startVideo = async () => {
    try {
      const recorder = await videoOutput.createRecorder({ maxDuration: MAX_VIDEO_SECONDS });
      let resolveFinished;
      const finished = new Promise((resolve) => { resolveFinished = resolve; });
      await recorder.startRecording((path) => resolveFinished(path), () => resolveFinished(null));
      return { recorder, finished, startedAt: Date.now() };
    } catch (err) {
      return null;
    }
  };

  const stopVideo = async (video) => {
    if (!video) return null;
    try {
      const elapsed = (Date.now() - video.startedAt) / 1000;
      if (elapsed < MIN_VIDEO_SECONDS) await wait((MIN_VIDEO_SECONDS - elapsed) * 1000);
      await video.recorder.stopRecording();
      const path = await Promise.race([video.finished, wait(4000).then(() => null)]);
      return path ? `file://${path}` : null;
    } catch (err) {
      return null;
    }
  };

  const cancelVideo = (video) => {
    if (video) video.recorder.cancelRecording().catch(() => {});
  };

  const runLiveness = () => new Promise((resolve) => {
    if (runRef.current) runRef.current.finish({ ok: false, reason: 'cancelled' });
    const videoPromise = startVideo();

    const run = {
      phase: 'hold',
      goodSince: null,
      lastFaceAt: Date.now(),
      sawOpen: false,
      eyesClosed: false,
      lastHint: null,
      timer: null,
      done: false,
    };

    const armTimer = () => {
      clearTimeout(run.timer);
      const ms = run.phase === 'blink' ? BLINK_TIMEOUT_MS : HOLD_TIMEOUT_MS;
      run.timer = setTimeout(() => {
        run.finish({ ok: false, reason: run.phase === 'blink' ? 'blink' : (run.lastHint || 'no-face') });
      }, ms);
    };

    run.finish = async (result) => {
      if (run.done) return;
      run.done = true;
      clearTimeout(run.timer);
      if (runRef.current === run) runRef.current = null;
      if (!result.ok) {
        videoPromise.then(cancelVideo);
        resolve(result);
        return;
      }
      // Grab the still immediately -- this exact moment is eyes open, facing
      // the camera -- without waiting on the recorder.
      let photoUri = null;
      try {
        photoUri = await captureStill();
      } catch (err) {
        photoUri = null;
      }
      if (!photoUri) {
        videoPromise.then(cancelVideo);
        resolve({ ok: false, reason: 'capture' });
        return;
      }
      // Resolve right away; the video finishes writing in the background and
      // the caller awaits `video` only when it actually uploads.
      resolve({ ok: true, photoUri, video: videoPromise.then(stopVideo) });
    };

    // Detects open -> closed -> open eyes.
    const trackBlink = (face) => {
      const openness = eyeOpenness(face);
      if (openness == null) return false;
      if (!run.eyesClosed) {
        if (openness > EYES_OPEN_THRESHOLD) run.sawOpen = true;
        else if (run.sawOpen && openness < EYES_CLOSED_THRESHOLD) run.eyesClosed = true;
        return false;
      }
      return openness > EYES_OPEN_THRESHOLD;
    };

    run.onFrame = (face, hint, now) => {
      if (face) {
        run.lastFaceAt = now;
        run.lastHint = hint;
      }
      if (!face) {
        if (run.phase === 'blink' && now - run.lastFaceAt > FACE_LOST_MS) {
          // Face left the frame mid-blink: it has to be held steady again.
          run.phase = 'hold';
          run.goodSince = null;
          run.sawOpen = false;
          run.eyesClosed = false;
          armTimer();
        }
      } else if (hint) {
        if (run.phase === 'hold') run.goodSince = null;
      } else {
        if (run.goodSince == null) run.goodSince = now;
        const blinked = trackBlink(face);
        if (blinked && now - run.goodSince >= MIN_FACE_MS) {
          emitStatus({ phase: 'blink', faceDetected: true, hint: null, eyesClosed: false });
          run.finish({ ok: true });
          return;
        }
        if (run.phase === 'hold' && now - run.goodSince >= HOLD_MS) {
          run.phase = 'blink';
          armTimer();
        }
      }
      emitStatus({ phase: run.phase, faceDetected: !!face, hint, eyesClosed: run.eyesClosed });
    };

    runRef.current = run;
    lastStatusRef.current = null;
    emitStatus({ phase: 'hold', faceDetected: false, hint: null, eyesClosed: false });
    armTimer();
  });

  useImperativeHandle(ref, () => ({
    runLiveness,
    cancel: () => runRef.current?.finish({ ok: false, reason: 'cancelled' }),
  }));

  useEffect(() => () => runRef.current?.finish({ ok: false, reason: 'cancelled' }), []);

  if (!device) return null;
  return (
    <VisionCamera.Camera
      ref={cameraRef}
      style={style || StyleSheet.absoluteFill}
      device={device}
      isActive
      outputs={outputs}
      resizeMode="cover"
      onStarted={() => onReadyRef.current?.()}
    />
  );
});

// Expo Go fallback: expo-camera still-photo polling, no video.
const ExpoGoLiveCamera = forwardRef(function ExpoGoLiveCamera({ style, onReady, onStatus }, ref) {
  const cameraRef = useRef(null);
  const activeRef = useRef(false);
  const [pictureSize, setPictureSize] = useState(undefined);
  const readyRef = useRef(false);

  const handleCameraReady = async () => {
    if (readyRef.current) return;
    readyRef.current = true;
    const size = cameraRef.current ? await choosePictureSize(cameraRef.current) : undefined;
    if (size) {
      setPictureSize(size);
      await wait(250);
    }
    onReady?.();
  };

  useImperativeHandle(ref, () => ({
    runLiveness: async () => {
      if (!cameraRef.current) return { ok: false, reason: 'capture' };
      activeRef.current = true;
      const result = await runLivenessAttempt({
        camera: cameraRef.current,
        isActive: () => activeRef.current && !!cameraRef.current,
        onStatus,
      });
      activeRef.current = false;
      if (!result.ok) return result;
      return { ok: true, photoUri: result.photo.uri, video: Promise.resolve(null) };
    },
    cancel: () => { activeRef.current = false; },
  }));

  useEffect(() => () => { activeRef.current = false; }, []);

  return (
    <CameraView
      ref={cameraRef}
      style={style || StyleSheet.absoluteFill}
      facing="front"
      mute
      pictureSize={pictureSize}
      onCameraReady={handleCameraReady}
    />
  );
});

const LiveFaceCamera = IS_EXPO_GO ? ExpoGoLiveCamera : NativeLiveCamera;
export default LiveFaceCamera;

export function discardCapture(result) {
  if (!result) return;
  if (result.photoUri) discardPhoto({ uri: result.photoUri });
  if (result.video) Promise.resolve(result.video).then((uri) => uri && discardPhoto({ uri }));
}
