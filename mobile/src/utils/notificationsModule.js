import { Platform } from 'react-native';
import { IS_EXPO_GO } from './expoGo';

// expo-notifications crashes Android Expo Go on load; exports null there.
const unsupported = IS_EXPO_GO && Platform.OS === 'android';

const Notifications = unsupported ? null : require('expo-notifications');

export default Notifications;
