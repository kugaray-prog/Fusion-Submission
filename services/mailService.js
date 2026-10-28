const dns = require('dns').promises;
const nodemailer = require('nodemailer');

// Outgoing email (admin verification codes, certificates). Senders are tried in order:
// 1. Gmail SMTP: SMTP_USER, SMTP_PASS (App Password), SMTP_HOST, SMTP_PORT
// 2. Brevo: BREVO_API_KEY, MAIL_FROM_EMAIL
// 3. Apps Script relay (scripts/mail-relay.gs): MAIL_RELAY_URL, MAIL_RELAY_SECRET
// MAIL_FROM_NAME sets the display name. With none configured, development
// prints the email to the terminal and production throws.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const FROM_NAME = () => process.env.MAIL_FROM_NAME || 'GeoAttend CSPC';

const hasSmtp = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const hasBrevo = () => Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
const hasRelay = () => Boolean(process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET);

function isConfigured() {
  return hasSmtp() || hasBrevo() || hasRelay();
}

// attachments: [{ filename, content: Buffer, contentType }].
async function sendMail({ to, subject, html, text, attachments = [] }) {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Email sending is not configured on this server (set SMTP_USER/SMTP_PASS, BREVO_API_KEY/MAIL_FROM_EMAIL or MAIL_RELAY_URL/MAIL_RELAY_SECRET).'), { status: 503 });
    }
    console.log('\n[mail] No email sender configured -- email NOT sent, printed here instead:');
    console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n[mail] ${text || html}`);
    if (attachments.length) console.log(`[mail] Attachments: ${attachments.map((a) => a.filename).join(', ')}`);
    console.log('');
    return { sent: false, printed: true };
  }

  const message = { to, subject, html, text, attachments };
  const hasFallback = hasBrevo() || hasRelay();
  const senders = [
    hasSmtp() && !(hasFallback && Date.now() < smtpUnreachableUntil) && ['Gmail SMTP', sendViaSmtp],
    hasBrevo() && ['Brevo', sendViaBrevo],
    hasRelay() && ['Apps Script relay', sendViaRelay]
  ].filter(Boolean);
  let lastError = null;
  for (const [name, send] of senders) {
    try {
      return await send(message);
    } catch (err) {
      lastError = err;
      console.warn(`[mail] ${name} failed (${err.message}).`);
    }
  }
  if (senders.length > 1) console.error('[mail] All senders failed.');
  throw lastError;
}

const SMTP_CONNECTION_ERRORS = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'];
// After an SMTP connection failure, skip SMTP for this long when another
// sender is configured (hosts that block SMTP time out on every attempt).
const SMTP_RETRY_AFTER_MS = 10 * 60 * 1000;
let smtpUnreachableUntil = 0;

let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS.replace(/\s+/g, '') },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
  }
  return smtpTransport;
}

// Gmail rewrites From to SMTP_USER anyway.
async function sendViaSmtp({ to, subject, html, text, attachments }) {
  try {
    await getSmtpTransport().sendMail({
      from: { name: FROM_NAME(), address: process.env.SMTP_USER },
      to,
      subject,
      html,
      text,
      attachments
    });
  } catch (err) {
    console.error(`[mail] SMTP rejected the email to ${to}: ${err.code || ''} ${err.response || err.message}`);
    if (SMTP_CONNECTION_ERRORS.includes(err.code)) smtpUnreachableUntil = Date.now() + SMTP_RETRY_AFTER_MS;
    throw Object.assign(new Error(`The email could not be sent. ${explainSmtpError(err)}`), { status: 502 });
  }
  return { sent: true, via: 'smtp' };
}

function explainSmtpError(err) {
  if (err.code === 'EAUTH' || err.responseCode === 535) {
    return 'Gmail rejected the login. SMTP_PASS must be a 16-character App Password (Google Account > Security > 2-Step Verification > App passwords), not your normal Gmail password.';
  }
  if (SMTP_CONNECTION_ERRORS.includes(err.code)) {
    return 'Could not connect to the SMTP server. This host may block outbound SMTP (Render\'s free tier does) -- use Brevo or the Apps Script relay there.';
  }
  return `SMTP said: ${err.response || err.message}`;
}

async function sendViaBrevo({ to, subject, html, text, attachments }) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM_EMAIL, name: FROM_NAME() },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      ...(attachments.length && {
        attachment: attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') }))
      })
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mail] Brevo rejected the email to ${to}: ${res.status} ${body}`);
    throw Object.assign(new Error(`The email could not be sent. ${explainBrevoError(res.status, body)}`), { status: 502 });
  }
  return { sent: true, via: 'brevo' };
}

async function sendViaRelay({ to, subject, html, text, attachments }) {
  const fail = (reason) => Object.assign(new Error(`The email could not be sent. ${reason}`), { status: 502 });
  let res;
  try {
    res = await fetch(process.env.MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: process.env.MAIL_RELAY_SECRET, to, subject, html, text, name: FROM_NAME(),
        attachments: attachments.map((a) => ({
          name: a.filename, mimeType: a.contentType || 'application/octet-stream', base64: a.content.toString('base64')
        }))
      }),
      redirect: 'follow'
    });
  } catch (err) {
    console.error(`[mail] Apps Script relay unreachable: ${err.message}`);
    throw fail('The email relay could not be reached. Check MAIL_RELAY_URL.');
  }
  const body = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(body); } catch (e) { /* HTML = not deployed for "Anyone" */ }
  if (!res.ok || !data || !data.ok) {
    console.error(`[mail] Apps Script relay failed for ${to}: ${res.status} ${body.slice(0, 300)}`);
    if (!data) throw fail('The email relay did not answer. Redeploy the Apps Script as a Web App with access set to "Anyone", and use the URL ending in /exec.');
    if (data.error === 'bad_secret') throw fail('MAIL_RELAY_SECRET does not match RELAY_SECRET in the Apps Script.');
    throw fail(`Apps Script said: ${data.error || `HTTP ${res.status}`}`);
  }
  return { sent: true, via: 'relay' };
}

function explainBrevoError(status, body) {
  let message = '';
  try { message = JSON.parse(body).message || ''; } catch (e) { message = body; }
  if (/unrecogni[sz]ed IP/i.test(message)) {
    return 'Brevo blocked this server\'s IP address. In Brevo, open Security > Authorized IPs and deactivate IP blocking (the host\'s IP changes, so it can\'t be allow-listed).';
  }
  if (/not yet activated/i.test(message)) {
    return 'Brevo has not activated email sending on this account yet. Complete your Brevo profile and ask contact@brevo.com to activate transactional email.';
  }
  if (/sender/i.test(message)) {
    return `Brevo rejected the sender: MAIL_FROM_EMAIL (${process.env.MAIL_FROM_EMAIL}) must exactly match a verified sender in Brevo (Senders, Domains & Dedicated IPs > Senders).`;
  }
  if (status === 401) {
    return 'Brevo rejected the API key. BREVO_API_KEY must be an API key (starts with "xkeysib-"), not an SMTP key.';
  }
  return `Brevo said: ${message || `HTTP ${status}`}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Checks syntax and that the domain has MX/A records, catching typos like
// "gmial.com". Other DNS failures don't block.
async function checkDeliverable(email) {
  if (!EMAIL_RE.test(email || '')) return { ok: false, reason: 'Enter a valid email address.' };
  const domain = email.split('@')[1].toLowerCase();
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) return { ok: true };
  } catch (err) {
    if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return { ok: true };
  }
  try {
    await dns.resolve4(domain);
    return { ok: true };
  } catch (err) {
    if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return { ok: true };
  }
  return { ok: false, reason: `"${domain}" can't receive email. Check the address for typos.` };
}

module.exports = { sendMail, checkDeliverable };
