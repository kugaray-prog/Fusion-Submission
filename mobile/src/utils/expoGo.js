import Constants, { ExecutionEnvironment } from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';

// Expo Go detection; a missing NitroModules native module also means Expo Go.
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo' ||
  !TurboModuleRegistry.get('NitroModules');
