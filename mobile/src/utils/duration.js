// Seconds -> "1h 24m" / "42m".
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// Closed-session total plus the open session's elapsed time, capped at
// pendingExitAt when a local exit hasn't reached the server yet.
export function liveDurationSeconds(record, nowMs = Date.now()) {
  const base = Number(record?.total_duration_seconds) || 0;
  if (!record?.open_session_time_in) return base;
  const openSince = new Date(record.open_session_time_in).getTime();
  if (Number.isNaN(openSince)) return base;
  let effectiveNowMs = nowMs;
  if (record.pendingExitAt) {
    const exitMs = new Date(record.pendingExitAt).getTime();
    if (!Number.isNaN(exitMs)) effectiveNowMs = Math.min(nowMs, exitMs);
  }
  return base + Math.max(0, (effectiveNowMs - openSince) / 1000);
}
