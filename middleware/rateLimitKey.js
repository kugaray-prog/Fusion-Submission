const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { getClientIp } = require('../services/networkService');

// Key limiters on the real client IP (CF-Connecting-IP, then X-Forwarded-For),
// not the proxy address. See networkService.getClientIp.
const clientRateLimitOptions = {
  keyGenerator: (req) => getClientIp(req) || req.ip,
  validate: { xForwardedForHeader: false }
};

// Signed-in requests are keyed per account, since every phone on campus Wi-Fi
// shares one public IP. The token is verified so forged ones fall back to IP.
function accountOrClientKey(req) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || (req.cookies && req.cookies.token);
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      if (decoded && decoded.id != null) return `${decoded.type || 'admin'}:${decoded.id}`;
    } catch (e) {
    }
  }
  return getClientIp(req) || req.ip;
}

const accountRateLimitOptions = {
  keyGenerator: accountOrClientKey,
  validate: { xForwardedForHeader: false }
};

module.exports = { clientRateLimitOptions, accountRateLimitOptions };
