import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import { IS_EXPO_GO } from '../utils/expoGo';
import * as Network from 'expo-network';

// react-native-wifi-reborn is Android-only and missing in Expo Go; others use expo-network.
// eslint-disable-next-line global-require
const WifiManager = Platform.OS === 'android' && !IS_EXPO_GO ? require('react-native-wifi-reborn').default : null;

// Whether Wi-Fi is on and connected. Polled, and re-checked when the app
// returns to the foreground.
const CHECK_INTERVAL_MS = 4000;

const WifiStatusContext = createContext(null);

export function WifiStatusProvider({ children }) {
  // Assume on until the first check to avoid a flash of the gate.
  const [wifiOn, setWifiOn] = useState(true);
  const [checked, setChecked] = useState(false);
  const appState = useRef(AppState.currentState);

  const checkNow = useCallback(async () => {
    try {
      if (WifiManager) {
        const [enabled, connected] = await Promise.all([
          WifiManager.isEnabled(),
          WifiManager.connectionStatus().catch(() => false),
        ]);
        setWifiOn(!!enabled && !!connected);
      } else {
        // iOS: only the connection type is available; anything but Wi-Fi counts as off.
        const state = await Network.getNetworkStateAsync();
        setWifiOn(state.type === Network.NetworkStateType.WIFI && state.isConnected !== false);
      }
    } catch (e) {
      // Don't block the app if the check itself fails.
      setWifiOn(true);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    checkNow();
    const interval = setInterval(checkNow, CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        checkNow();
      }
      appState.current = next;
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [checkNow]);

  return (
    <WifiStatusContext.Provider value={{ wifiOn, checked, recheck: checkNow }}>
      {children}
    </WifiStatusContext.Provider>
  );
}

// Defaults to enabled outside the provider.
export function useWifiStatus() {
  const ctx = useContext(WifiStatusContext);
  return ctx || { wifiOn: true, checked: true, recheck: () => {} };
}
