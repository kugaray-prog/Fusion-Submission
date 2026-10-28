import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra || {};

// Google OAuth client IDs (Web is required; must match the server's GOOGLE_CLIENT_ID).
export const GOOGLE_WEB_CLIENT_ID = extra.googleWebClientId || '';
export const GOOGLE_IOS_CLIENT_ID = extra.googleIosClientId || '';
export const GOOGLE_ANDROID_CLIENT_ID = extra.googleAndroidClientId || '';

export const isGoogleConfigured = () =>
  !!GOOGLE_WEB_CLIENT_ID && !GOOGLE_WEB_CLIENT_ID.startsWith('your_');

// Set extra.apiBaseUrl in app.json (LAN IP or deployed URL).
export const API_BASE_URL = extra.apiBaseUrl || 'http://172.16.81.79:2620/api';

// Server root for /uploads URLs.
export const ASSET_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');

// "/uploads/..." -> full URL, or null.
export function assetUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path; // already absolute
  return `${ASSET_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
