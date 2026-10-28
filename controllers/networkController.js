const networkService = require('../services/networkService');
const { logAction } = require('../services/auditService');

// GET /api/network/check (employee)
// `enforced` is false until an allowed IP is configured.
async function checkEmployeeNetwork(req, res, next) {
  try {
    const ip = await networkService.resolveClientIp(req);
    const entries = await networkService.getAllowedEntries();
    const enforced = entries.length > 0;
    res.json({
      success: true,
      data: { ip, enforced, allowed: !enforced || networkService.isAllowed(ip, entries) }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/network/settings (super admin). `your_ip` is the admin's public IP.
async function getSettings(req, res, next) {
  try {
    const entries = await networkService.getAllowedEntries();
    res.json({ success: true, data: { allowed_ips: entries, your_ip: await networkService.resolveClientIp(req) } });
  } catch (err) {
    next(err);
  }
}

// PUT /api/network/settings { allowed_ips: "a, b\nc" | ["a", "b"] }
async function updateSettings(req, res, next) {
  try {
    const { allowed_ips } = req.body;
    const entries = [...new Set(networkService.splitEntries(Array.isArray(allowed_ips) ? allowed_ips.join('\n') : allowed_ips))];
    const errors = entries.map(networkService.validateEntry).filter(Boolean);
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' ') });
    }
    await networkService.saveAllowedEntries(entries);
    await logAction({ adminId: req.admin.id, action: 'update', module: 'network_settings', details: { allowed_ips: entries }, ip: req.ip });
    res.json({ success: true, message: 'Allowed network IPs saved.', data: { allowed_ips: entries } });
  } catch (err) {
    next(err);
  }
}

module.exports = { checkEmployeeNetwork, getSettings, updateSettings };
