/** Haversine distance in meters. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Ray-casting point-in-polygon. Coordinates are coerced to Number because
 * mysql2 returns DECIMAL columns as strings.
 */
function isInsidePolygon(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i].lat), yi = Number(points[i].lng);
    const xj = Number(points[j].lat), yj = Number(points[j].lng);
    const intersect =
      yi > lng !== yj > lng &&
      lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Distance in meters from a point to the polygon boundary (equirectangular
 * projection, accurate at geofence scale).
 */
function distanceToPolygonEdgeMeters(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const xy = points.map((p) => ({ x: (Number(p.lng) - lng) * mPerDegLng, y: (Number(p.lat) - lat) * mPerDegLat }));
  let best = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const a = xy[j];
    const b = xy[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

/**
 * Returns { inside, distanceMeters }. A point within toleranceMeters outside
 * the boundary still counts as inside.
 */
function isInsideGeofence(lat, lng, geofence, toleranceMeters = 0) {
  const tol = Math.max(0, Number(toleranceMeters) || 0);
  if (geofence.shape_type === 'circle') {
    const dist = distanceMeters(Number(lat), Number(lng), Number(geofence.center_lat), Number(geofence.center_lng));
    const outsideBy = Math.max(0, dist - Number(geofence.radius_meters));
    return { inside: outsideBy <= tol, distanceMeters: Math.round(outsideBy) };
  }
  const points = geofence.points || [];
  if (points.length < 3) return { inside: false, distanceMeters: null };
  if (isInsidePolygon(lat, lng, points)) return { inside: true, distanceMeters: 0 };
  const outsideBy = distanceToPolygonEdgeMeters(lat, lng, points);
  return { inside: outsideBy <= tol, distanceMeters: Math.round(outsideBy) };
}

module.exports = { distanceMeters, isInsideGeofence };
