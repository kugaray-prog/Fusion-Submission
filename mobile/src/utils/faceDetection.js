import { IS_EXPO_GO } from './expoGo';

// ML Kit isn't in Expo Go; there a fake detector always passes hold and blink.

let eyesOpen = true;
const expoGoStub = {
  detect: async () => {
    eyesOpen = !eyesOpen;
    const p = eyesOpen ? 0.99 : 0.01;
    return [{ leftEyeOpenProbability: p, rightEyeOpenProbability: p }];
  },
};

// eslint-disable-next-line global-require
const FaceDetection = IS_EXPO_GO ? expoGoStub : require('@react-native-ml-kit/face-detection').default;

export default FaceDetection;
