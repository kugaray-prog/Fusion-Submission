import * as Application from 'expo-application';
import * as Device from 'expo-device';

// Stable device ID used everywhere the server needs to identify this phone.
export function getDeviceUid() {
  return Application.androidId || Device.osBuildId || 'unknown-device';
}

// Device details as shown and submitted at registration.
export function getDeviceInfo() {
  return {
    uid: getDeviceUid(),
    model: Device.modelName || 'Unknown',
    brand: Device.brand || 'Unknown',
    os: `${osName()} ${Device.osVersion || ''}`.trim() || 'Unknown'
  };
}

// Some vendors put a full build fingerprint in osName; use "Android" then.
function osName() {
  const name = (Device.osName || '').trim();
  if (/[/:]/.test(name)) return 'Android';
  return name;
}
