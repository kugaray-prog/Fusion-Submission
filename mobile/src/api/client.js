import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config';
import { getDeviceUid } from '../utils/device';

export { API_BASE_URL };

const api = axios.create({ baseURL: API_BASE_URL, timeout: 15000 });

// Face recognition and a sleeping server can take well over the default timeout.
const FACE_UPLOAD_TIMEOUT_MS = 120000;

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('employee_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Lets the server refuse every request from a device an admin has
  // blacklisted or rejected (code DEVICE_BLOCKED below).
  config.headers['X-Device-Uid'] = getDeviceUid();
  return config;
});

// Set by AuthContext; signs out when the server says the employee no longer exists.
let staleSessionHandler = null;
export function setStaleSessionHandler(fn) {
  staleSessionHandler = fn;
}

// Set by AuthContext. Called with (message, deviceStatus) when the server
// reports this device was blacklisted/rejected by an admin.
let deviceBlockedHandler = null;
export function setDeviceBlockedHandler(fn) {
  deviceBlockedHandler = fn;
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const code = error?.response?.data?.code;
    if ((code === 'EMPLOYEE_NOT_FOUND' || code === 'STALE_REFERENCE') && staleSessionHandler) {
      staleSessionHandler();
    }
    if (code === 'DEVICE_BLOCKED' && deviceBlockedHandler) {
      deviceBlockedHandler(error.response.data.message, error.response.data.deviceStatus);
    }
    return Promise.reject(error);
  }
);

export async function registerDevice(payload) {
  const { data } = await api.post('/devices/register', payload);
  return data;
}

// POST /api/employee-auth/google { credential, device_uid }
export async function googleLogin(credential, deviceUid) {
  const { data } = await api.post(
    '/employee-auth/google',
    { credential, device_uid: deviceUid },
    { timeout: FACE_UPLOAD_TIMEOUT_MS }
  );
  return data;
}

// GET /api/employee-auth/departments — public, used by the Device Registration
// screen to populate the Department dropdown before the employee has a token.
export async function getDepartments() {
  const { data } = await api.get('/employee-auth/departments');
  return data;
}

// GET /api/employee-auth/employee-options -> { positions, classifications }
export async function getEmployeeOptions() {
  const { data } = await api.get('/employee-auth/employee-options');
  return data;
}

// POST /api/employee-auth/link-device (multipart, includes the `image` selfie)
export async function linkDevice(formData) {
  const { data } = await api.post('/employee-auth/link-device', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: FACE_UPLOAD_TIMEOUT_MS
  });
  return data;
}

// GET /api/employee-auth/device-status?device_uid=
export async function getDeviceStatus(deviceUid) {
  const { data } = await api.get('/employee-auth/device-status', { params: { device_uid: deviceUid } });
  return data;
}

export async function submitAttendance(payload) {
  const { data } = await api.post('/attendance/submit', payload);
  return data;
}

// POST /api/attendance/:id/heartbeat. observedAt is when the reading was taken
// (may be a delayed retry); locationOff closes the session immediately.
export async function sendHeartbeat(attendanceId, latitude, longitude, observedAt, { accuracy, mocked, locationOff, offlineInsideSeconds } = {}) {
  const body = {};
  if (latitude != null) body.latitude = latitude;
  if (longitude != null) body.longitude = longitude;
  if (observedAt) body.observed_at = observedAt;
  if (accuracy != null) body.accuracy = accuracy;
  if (mocked) body.mocked = true;
  if (locationOff) body.location_off = true;
  if (offlineInsideSeconds) body.offline_inside_seconds = offlineInsideSeconds;
  const { data } = await api.post(`/attendance/${attendanceId}/heartbeat`, body);
  return data;
}

// GET /api/attendance/my-history
export async function getMyHistory() {
  const { data } = await api.get('/attendance/my-history');
  return data;
}

// POST /api/attendance/:id/face-verify (multipart: selfie, liveness_verified, liveness_actions, latitude?, longitude?)
export async function verifyAttendanceFace(attendanceId, formData) {
  const { data } = await api.post(`/attendance/${attendanceId}/face-verify`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: FACE_UPLOAD_TIMEOUT_MS
  });
  return data;
}

// GET /api/geofences/mobile/active (active and upcoming events)
export async function getGeofences() {
  const { data } = await api.get('/geofences/mobile/active');
  return data;
}

// GET /api/network/check -> { ip, enforced, allowed }
export async function checkOfficeNetwork() {
  const { data } = await api.get('/network/check');
  return data;
}

// PUT /api/devices/push-token — saves this phone's Expo push token so the
// server can announce new events while the app is closed; null clears it.
export async function savePushToken(token) {
  const { data } = await api.put('/devices/push-token', { token });
  return data;
}

export default api;
