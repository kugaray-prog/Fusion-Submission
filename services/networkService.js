const net = require('net');
const pool = require('../config/db');

// Office-network check: every access point on the office line shares one
// public IP (or IPv6 prefix). The allow-list (settings.allowed_network_ips,
// fallback ALLOWED_NETWORK_IPS) holds exact IPs or CIDR ranges, separated by
// commas or new lines.
const SETTING_KEY = 'allowed_network_ips';

function normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7); // IPv4-mapped IPv6
  return v;
}

// Real client IP: CF-Connecting-IP (set by Cloudflare, not spoofable), then
// True-Client-IP / X-Forwarded-For, then the socket address.
function getClientIp(req) {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    (req.headers['x-forwarded-for'] || '').split(',')[0],
    req.socket && req.socket.remoteAddress
  ];
  for (const c of candidates) {
    const ip = normalizeIp(c);
    if (net.isIP(ip)) return ip;
  }
  return '';
}

// Loopback/private ranges: these clients share the server's own public IP.
const LOCAL_RANGES = new net.BlockList();
LOCAL_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL_RANGES.addAddress('::1', 'ipv6');
LOCAL_RANGES.addSubnet('fc00::', 7, 'ipv6');
LOCAL_RANGES.addSubnet('fe80::', 10, 'ipv6');

function isLocalIp(ip) {
  const family = net.isIP(ip);
  return !!family && LOCAL_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const PUBLIC_IP_SOURCES = ['https://api.ipify.org', 'https://icanhazip.com'];
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000;
let publicIpCache = { ip: '', at: 0 };

// Cached for a few minutes; '' when no echo service is reachable.
async function getServerPublicIp() {
  if (publicIpCache.ip && Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS) return publicIpCache.ip;
  for (const url of PUBLIC_IP_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = normalizeIp(await res.text());
      if (net.isIP(ip)) {
        publicIpCache = { ip, at: Date.now() };
        return ip;
      }
    } catch (_) { /* try the next source */ }
  }
  return '';
}

// Like getClientIp, but a local/LAN address is replaced by the server's public IP.
async function resolveClientIp(req) {
  const ip = getClientIp(req);
  if (!isLocalIp(ip)) return ip;
  return (await getServerPublicIp()) || ip;
}

function splitEntries(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateEntry(entry) {
  const [addr, bits, extra] = entry.split('/');
  const family = net.isIP(addr);
  if (!family || extra !== undefined) return `"${entry}" is not a valid IP address or CIDR range.`;
  if (bits !== undefined) {
    const n = Number(bits);
    const max = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(bits) || n < 8 || n > max) {
      return `"${entry}" has an invalid prefix length (use /8 to /${max}).`;
    }
  }
  return null;
}

function buildBlockList(entries) {
  const list = new net.BlockList();
  for (const entry of entries) {
    if (validateEntry(entry)) continue;
    const [addr, bits] = entry.split('/');
    const type = net.isIP(addr) === 4 ? 'ipv4' : 'ipv6';
    if (bits !== undefined) list.addSubnet(addr, Number(bits), type);
    else list.addAddress(addr, type);
  }
  return list;
}

function isAllowed(ip, entries) {
  const family = net.isIP(ip);
  if (!family) return false;
  return buildBlockList(entries).check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function getAllowedEntries() {
  const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [SETTING_KEY]);
  const raw = rows[0] ? rows[0].setting_value : process.env.ALLOWED_NETWORK_IPS;
  return splitEntries(raw);
}

async function saveAllowedEntries(entries) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [SETTING_KEY, entries.join('\n')]
  );
}

module.exports = { getClientIp, resolveClientIp, splitEntries, validateEntry, isAllowed, getAllowedEntries, saveAllowedEntries };
