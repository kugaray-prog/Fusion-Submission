import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { AppState } from 'react-native';

// Whether the Location service is on (not just permitted). Polled, and
// re-checked when the app returns to the foreground.
const CHECK_INTERVAL_MS = 4000;

const LocationStatusContext = createContext(null);

export function LocationStatusProvider({ children }) {
  // Assume on until the first check to avoid a flash of the gate.
  const [locationEnabled, setLocationEnabled] = useState(true);
  const [checked, setChecked] = useState(false);
  const appState = useRef(AppState.currentState);

  const checkNow = useCallback(async () => {
    try {
      const enabled = await Location.hasServicesEnabledAsync();
      setLocationEnabled(enabled);
    } catch (e) {
      // Don't block the app if the check itself fails.
      setLocationEnabled(true);
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
    <LocationStatusContext.Provider value={{ locationEnabled, checked, recheck: checkNow }}>
      {children}
    </LocationStatusContext.Provider>
  );
}

// Defaults to enabled outside the provider.
export function useLocationStatus() {
  const ctx = useContext(LocationStatusContext);
  return ctx || { locationEnabled: true, checked: true, recheck: () => {} };
}
