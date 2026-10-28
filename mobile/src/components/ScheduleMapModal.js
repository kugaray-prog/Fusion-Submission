import React, { useState } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Linking, ScrollView } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '../theme';
import { useResponsive, MODAL_ORIENTATIONS } from '../utils/responsive';

// react-native-maps is native-only, and a missing Android Maps key crashes the
// MapView, so fall back to a coordinates card on web or without a real key.
function looksLikeRealKey(key) {
  return !!key && !key.startsWith('YOUR_');
}

const expoConfig = Constants.expoConfig || Constants.manifest || {};
const androidMapsKey = expoConfig?.android?.config?.googleMaps?.apiKey;
// iOS uses Apple Maps (no key needed).
const hasValidMapsKey =
  Platform.OS === 'android' ? looksLikeRealKey(androidMapsKey) :
  Platform.OS === 'ios' ? true :
  false;

let MapView = null;
let Marker = null;
let Polygon = null;
if (Platform.OS !== 'web' && hasValidMapsKey) {
  // eslint-disable-next-line global-require
  const Maps = require('react-native-maps');
  MapView = Maps.default;
  Marker = Maps.Marker;
  Polygon = Maps.Polygon;
}

function centroid(points) {
  if (!points || points.length === 0) return null;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { latitude: sum.lat / points.length, longitude: sum.lng / points.length };
}

function fmtDate(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtTime(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Event venue map with its geofence and schedule.
export default function ScheduleMapModal({ visible, schedule, onClose }) {
  const { isTablet, isCompactHeight, insets } = useResponsive();
  const [mapType, setMapType] = useState('standard'); // 'standard' | 'satellite'
  if (!schedule) return null;

  // A large map, like the admin Geo-Fences page: shorter on a phone held in
  // landscape, taller on a tablet; the details below it scroll if needed.
  const mapHeight = isCompactHeight ? 160 : isTablet ? 440 : 340;

  const points = schedule.points || [];
  const center = centroid(points);
  const region = center
    ? { ...center, latitudeDelta: 0.0045, longitudeDelta: 0.0045 }
    : null;
  // Without a working map (no Maps API key configured, or web), the sheet
  // skips the map area entirely; "Open in Maps" still shows the location.
  const showMap = !!(MapView && region);

  const openInMaps = () => {
    if (!center) return;
    const label = encodeURIComponent(schedule.venue || schedule.title || 'Event location');
    const url = Platform.select({
      ios: `maps:0,0?q=${label}@${center.latitude},${center.longitude}`,
      android: `geo:0,0?q=${center.latitude},${center.longitude}(${label})`,
      default: `https://www.google.com/maps/search/?api=1&query=${center.latitude},${center.longitude}`,
    });
    Linking.openURL(url).catch(() => {});
  };

  return (
    <Modal visible={visible} animationType="slide" transparent supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
          <View style={styles.handle} />

          {showMap && (
            <View style={[styles.mapWrap, { height: mapHeight }]}>
              <MapView
                style={styles.map}
                initialRegion={region}
                mapType={mapType}
                showsPointsOfInterest
                showsBuildings
                toolbarEnabled={false}
                pointerEvents="auto"
              >
                {points.length >= 3 && Polygon && (
                  <Polygon
                    coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                    strokeColor={colors.primary}
                    fillColor="rgba(13, 0, 165, 0.15)"
                    strokeWidth={2}
                  />
                )}
                {Marker && <Marker coordinate={center} title={schedule.venue || schedule.title} />}
              </MapView>
              {/* Map | Satellite switch, like the Google Maps control on the admin page */}
              <View style={styles.mapTypeSwitch}>
                {[['standard', 'Map'], ['satellite', 'Satellite']].map(([key, label], i) => (
                  <TouchableOpacity
                    key={key}
                    style={[styles.mapTypeBtn, i > 0 && styles.mapTypeBtnDivider]}
                    onPress={() => setMapType(key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mapType === key }}
                  >
                    <Text style={[styles.mapTypeText, mapType === key && styles.mapTypeTextActive]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close">
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          )}

          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body}>
            <View style={styles.titleRow}>
              <Text style={[styles.title, { flex: 1 }]}>{schedule.title}</Text>
              {!showMap && (
                <TouchableOpacity style={styles.closeInline} onPress={onClose} accessibilityLabel="Close">
                  <Ionicons name="close" size={20} color={colors.textSub} />
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.venueRow}>
              <Ionicons name="location-outline" size={14} color={colors.textSub} />
              <Text style={styles.venue}>{schedule.venue || 'Venue TBA'}</Text>
            </View>

            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Date</Text>
                <Text style={styles.metaValue}>{fmtDate(schedule.start_datetime)}</Text>
              </View>
              <View style={styles.metaDivider} />
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Time</Text>
                <Text style={styles.metaValue}>
                  {fmtTime(schedule.start_datetime)}{schedule.end_datetime ? ` – ${fmtTime(schedule.end_datetime)}` : ''}
                </Text>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <TouchableOpacity style={styles.btnOutline} onPress={onClose}>
                <Text style={styles.btnOutlineText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btnPrimary, !center && styles.btnDisabled]} onPress={openInMaps} disabled={!center}>
                <Text style={styles.btnPrimaryText}>Open in Maps</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(27, 37, 89, 0.45)', justifyContent: 'flex-end' },
  // Full width on phones; a centered sheet on tablets.
  sheet: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '100%',
    alignSelf: 'center',
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    ...shadow,
  },
  handle: {
    alignSelf: 'center', width: 44, height: 5, borderRadius: 3,
    backgroundColor: colors.border, marginTop: 10, marginBottom: 4,
  },
  mapWrap: { marginTop: 8 },
  map: { width: '100%', height: '100%' },
  mapTypeSwitch: {
    position: 'absolute', top: 12, left: 12, flexDirection: 'row',
    backgroundColor: colors.white, borderRadius: 4, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3,
  },
  mapTypeBtn: { paddingVertical: 9, paddingHorizontal: 14 },
  mapTypeBtnDivider: { borderLeftWidth: 1, borderLeftColor: '#E6E6E6' },
  mapTypeText: { fontSize: 14, color: '#565656', fontWeight: '500' },
  mapTypeTextActive: { color: '#000', fontWeight: '700' },
  closeBtn: {
    position: 'absolute', top: 14, right: 14, width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(27, 37, 89, 0.55)', alignItems: 'center', justifyContent: 'center',
  },
  bodyScroll: { flexGrow: 0, flexShrink: 1 },
  body: { padding: 24, paddingTop: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  closeInline: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 19, fontWeight: '700', color: colors.textMain, letterSpacing: -0.2 },
  venueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  venue: { fontSize: 13, color: colors.textSub, fontWeight: '500' },
  metaRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 18,
    backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: 16,
  },
  metaItem: { flex: 1 },
  metaDivider: { width: 1, height: '100%', backgroundColor: colors.border, marginHorizontal: 14 },
  metaLabel: { fontSize: 10, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  metaValue: { fontSize: 13, fontWeight: '700', color: colors.textMain },
  actionsRow: { flexDirection: 'row', gap: 12, marginTop: 22 },
  btnOutline: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
  },
  btnOutlineText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  btnPrimary: { flex: 1, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnDisabled: { opacity: 0.4 },
});
