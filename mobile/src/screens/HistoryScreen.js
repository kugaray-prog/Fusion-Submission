import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../api/client';
import { colors, radius, shadow, type } from '../theme';
import BottomNav from '../components/BottomNav';
import StatusPill from '../components/StatusPill';
import FadeIn from '../components/FadeIn';
import AppHeader from '../components/AppHeader';
import Skeleton from '../components/Skeleton';
import { formatDuration, liveDurationSeconds } from '../utils/duration';
import { useLiveUpdates } from '../api/realtime';
import { useResponsive, MAX_WIDTH } from '../utils/responsive';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'ongoing', label: 'On-going' },
  { key: 'completed', label: 'Completed' },
  { key: 'present', label: 'Present' },
  { key: 'late', label: 'Late' },
  { key: 'absent', label: 'Absent' },
];

export default function HistoryScreen({ navigation }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  // Log cards go two-up on a wide (tablet landscape) screen.
  const { isWide, topPad, contentStyle } = useResponsive();
  const columns = isWide ? 2 : 1;
  const column = contentStyle(isWide ? MAX_WIDTH.wide : MAX_WIDTH.content);
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/attendance/my-history');
      setRecords(data.data || []);
    } catch (err) {
      // Keep what's on screen: this also runs on live updates in the
      // background, where a brief network blip shouldn't blank the list.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // An admin edited this employee's attendance, or an event ended and its
  // final status was settled.
  useLiveUpdates(['attendance'], load);

  // Tick open records' durations every second.
  useEffect(() => {
    const hasOpenSession = records.some((r) => !r.time_out);
    if (!hasOpenSession) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [records]);

  const filteredRecords = useMemo(() => {
    switch (filter) {
      case 'ongoing': return records.filter((r) => r.attendance_status === 'Ongoing');
      case 'completed': return records.filter((r) => r.attendance_status !== 'Ongoing');
      case 'present': return records.filter((r) => r.attendance_status === 'Present');
      case 'late': return records.filter((r) => r.attendance_status === 'Late');
      case 'absent': return records.filter((r) => r.attendance_status === 'Absent');
      default: return records;
    }
  }, [records, filter]);

  return (
    <View style={styles.flex}>
      <View style={[column, { paddingTop: topPad }]}>
        <AppHeader title="Attendance Logs" />
      </View>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.filterRow, column, { paddingLeft: 0, paddingRight: 0 }]}
        contentContainerStyle={{ paddingLeft: column.paddingLeft, paddingRight: column.paddingRight, gap: 8 }}
        data={FILTERS}
        keyExtractor={(f) => f.key}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.filterChip, filter === item.key && styles.filterChipActive]}
            onPress={() => setFilter(item.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.filterChipText, filter === item.key && styles.filterChipTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        )}
      />
      {loading ? (
        <Skeleton rows={4} style={[column, { paddingTop: 12 }]} />
      ) : (
        <FlatList
          key={columns}
          style={styles.list}
          contentContainerStyle={[column, { paddingTop: 12, paddingBottom: 20 }]}
          numColumns={columns}
          columnWrapperStyle={columns > 1 ? styles.columnRow : undefined}
          data={filteredRecords}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIcon}>
                <Ionicons name="document-text-outline" size={26} color={colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>No attendance yet</Text>
              <Text style={styles.empty}>No attendance history found{filter !== 'all' ? ' for this filter.' : '.'}</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            // Ongoing until the event ends; Present/Late/Absent is only
            // decided then (80% presence over the whole event).
            const ongoing = item.attendance_status === 'Ongoing';
            const durationSeconds = liveDurationSeconds(item);
            return (
              <FadeIn delay={Math.min(index, 6) * 40} style={columns > 1 && styles.columnCell}>
                <View style={styles.card}>
                  <View style={styles.cardTopRow}>
                    <Text style={styles.eventTitle}>{item.event_title || 'N/A'}</Text>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {ongoing ? (
                        <StatusPill label="On-going" variant="waiting" />
                      ) : item.attendance_status && (
                        <StatusPill
                          label={item.attendance_status}
                          variant={item.attendance_status === 'Present' ? 'success' : (item.attendance_status === 'Late' ? 'waiting' : 'danger')}
                        />
                      )}
                    </View>
                  </View>
                  <View style={styles.metaRow}>
                    <Ionicons name="calendar-outline" size={13} color={colors.textSub} />
                    <Text style={styles.metaLine}>{item.attendance_date}</Text>
                  </View>
                  <View style={styles.timesRow}>
                    <View style={styles.timeBox}>
                      <Text style={styles.timeLabel}>Time in</Text>
                      <Text style={[styles.timeValue, { color: colors.successText }]}>{item.time_in ? new Date(item.time_in).toLocaleTimeString() : '--:--'}</Text>
                    </View>
                    <View style={styles.timeBox}>
                      <Text style={styles.timeLabel}>Time out</Text>
                      <Text style={[styles.timeValue, { color: item.time_out ? colors.dangerText : colors.textSub }]}>{item.time_out ? new Date(item.time_out).toLocaleTimeString() : '--:--'}</Text>
                    </View>
                  </View>
                  <View style={styles.durationRow}>
                    <Text style={styles.durationLabel}>Duration</Text>
                    <Text style={[styles.durationValue, !item.time_out && { color: colors.warningText }]}>
                      {formatDuration(durationSeconds)}
                    </Text>
                    {item.session_count > 1 && (
                      <Text style={styles.sessionCountText}>· {item.session_count} sessions</Text>
                    )}
                  </View>
                </View>
              </FadeIn>
            );
          }}
        />
      )}
      <BottomNav active="History" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  filterRow: { flexGrow: 0, marginTop: 2 },
  filterChip: {
    paddingVertical: 8, paddingHorizontal: 16, borderRadius: radius.pill,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 13, fontWeight: '600', color: colors.textSub },
  filterChipTextActive: { color: '#fff' },
  list: { flex: 1 },
  columnRow: { gap: 12 },
  columnCell: { flex: 1 / 2, minWidth: 0 },
  emptyWrap: { alignItems: 'center', marginTop: 48, paddingHorizontal: 24 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  emptyTitle: { ...type.heading, marginBottom: 4 },
  empty: { ...type.caption, textAlign: 'center' },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 16,
    marginBottom: 12, borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 },
  eventTitle: { fontWeight: '600', color: colors.textMain, fontSize: 15, flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaLine: { ...type.caption },
  timesRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  timeBox: { flex: 1, backgroundColor: colors.bg, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 12 },
  timeLabel: { fontSize: 11, fontWeight: '600', color: colors.textSub },
  timeValue: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  durationRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  durationLabel: { ...type.overline, marginRight: 8 },
  durationValue: { fontSize: 15, fontWeight: '700', color: colors.primary },
  sessionCountText: { ...type.caption, marginLeft: 6 },
});
