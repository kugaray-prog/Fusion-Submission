const path = require('path');

const EMAIL_DOMAIN = 'my.cspc.edu.ph';
// Accepted institutional domains (students on my.cspc.edu.ph, staff on cspc.edu.ph).
const INSTITUTIONAL_DOMAINS = [EMAIL_DOMAIN, 'cspc.edu.ph'];
// Old domain; seed.js migrates accounts off it.
const LEGACY_EMAIL_DOMAIN = 'geoattend.pro';

// Exact domain match, so lookalikes like evilcspc.edu.ph are rejected.
function isInstitutionalEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  return INSTITUTIONAL_DOMAINS.includes(value.slice(at + 1));
}

module.exports = {
  email: {
    domain: EMAIL_DOMAIN,
    domains: INSTITUTIONAL_DOMAINS,
    domainLabel: INSTITUTIONAL_DOMAINS.map(d => `@${d}`).join(' or '),
    legacyDomain: LEGACY_EMAIL_DOMAIN,
    defaultAdmin: (process.env.DEFAULT_ADMIN_EMAIL || `admin@${EMAIL_DOMAIN}`)
      .trim()
      .replace(/@geoattend\.pro$/i, `@${EMAIL_DOMAIN}`),
    isInstitutional: isInstitutionalEmail
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_change_me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  },
  ocr: {
    minConfidence: 70 // percent — below this, OCR result is rejected as low_confidence
  },
  // InsightFace models. buffalo_s by default (buffalo_l needs >512MB RAM).
  // Changing packs requires every employee to re-register their face.
  face: {
    detectorModelPath: process.env.FACE_DETECTOR_MODEL_PATH || path.join(__dirname, '..', 'models', 'det_500m.onnx'),
    detectorInputSize: Number(process.env.FACE_DETECTOR_INPUT_SIZE) || 640, // SCRFD's standard square input size
    detectorScoreThreshold: Number(process.env.FACE_DETECTOR_SCORE_THRESHOLD) || 0.5,
    detectorNmsThreshold: Number(process.env.FACE_DETECTOR_NMS_THRESHOLD) || 0.4,
    modelPath: process.env.FACE_MODEL_PATH || path.join(__dirname, '..', 'models', 'w600k_mbf.onnx'),
    inputSize: Number(process.env.FACE_INPUT_SIZE) || 112, // ArcFace/InsightFace recognizers expect 112x112 aligned faces
    // Cosine similarity at or above which two faces are the same person.
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD) || 0.5
  },
  attendance: {
    // Minutes after start that a time-in still counts as Present.
    lateGraceMinutes: 15,
    // Once the event ends, time inside the geofence below this fraction of the
    // event's duration marks the employee Absent.
    minAttendanceRatioForPresence: Number(process.env.ATTENDANCE_MIN_RATIO) || 0.8,
    // Reject GPS readings less accurate than this (meters). Desktop browsers
    // estimate location via WiFi/IP and will usually fail this.
    maxAccuracyMeters: Number(process.env.ATTENDANCE_MAX_ACCURACY_METERS) || 100,
    // Meters outside the boundary still counted as inside when within the reading's
    // accuracy. Keep in sync with mobile/src/context/AttendanceTrackingContext.js.
    edgeToleranceMeters: process.env.GEOFENCE_EDGE_TOLERANCE_METERS !== undefined
      ? Number(process.env.GEOFENCE_EDGE_TOLERANCE_METERS)
      : 0,
    rejectMockLocations: process.env.REJECT_MOCK_LOCATIONS !== 'false',
    // Consecutive outside readings before a session is auto-closed.
    autoEndOutsideStreakThreshold: Number(process.env.ATTENDANCE_AUTO_END_STREAK) || 1,
    heartbeatMinIntervalSeconds: Number(process.env.ATTENDANCE_HEARTBEAT_MIN_SECONDS) || 10,
    // Seconds without a heartbeat before an open session is timed out at the last
    // heartbeat. The app pings every ~12 s; 0 disables.
    silentSessionSeconds: process.env.ATTENDANCE_SILENT_SESSION_SECONDS !== undefined
      ? Number(process.env.ATTENDANCE_SILENT_SESSION_SECONDS)
      : 30,
    // Geo-anomaly: two phones within anomalyDistanceMeters for anomalyMinMatches
    // paired readings over anomalySustainSeconds are both flagged for face verification.
    anomalyDistanceMeters: Number(process.env.ANOMALY_DISTANCE_METERS) || 1,
    anomalyWindowSeconds: Number(process.env.ANOMALY_WINDOW_SECONDS) || 30,
    anomalyRecheckSeconds: Number(process.env.ANOMALY_RECHECK_SECONDS) || 30,
    anomalyPairSeconds: Number(process.env.ANOMALY_PAIR_SECONDS) || 6,
    anomalySustainSeconds: Number(process.env.ANOMALY_SUSTAIN_SECONDS) || 60,
    anomalyMinMatches: Number(process.env.ANOMALY_MIN_MATCHES) || 4,
    anomalyMaxAccuracyMeters: Number(process.env.ANOMALY_MAX_ACCURACY_METERS) || 10
  },
  // Default map center for new events (CSPC campus).
  defaultGeofence: {
    label: process.env.CSPC_LABEL || 'CSPC - Camarines Sur Polytechnic Colleges, Nabua, Camarines Sur',
    lat: Number(process.env.CSPC_LATITUDE) || 13.4059000,
    lng: Number(process.env.CSPC_LONGITUDE) || 123.3758000
  }
};
