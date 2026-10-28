/**
* GeoAttend email relay (Google Apps Script), used by services/mailService.js.
* Setup: paste into a new script.google.com project, set Script Property
* RELAY_SECRET (= MAIL_RELAY_SECRET), deploy as a Web app (Execute as: Me,
* Access: Anyone) and put its /exec URL in MAIL_RELAY_URL.
*/

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
    if (!secret || req.secret !== secret) return reply({ ok: false, error: 'bad_secret' });

    var to = String(req.to || '').trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return reply({ ok: false, error: 'invalid recipient' });
    if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, error: 'daily email quota reached, try again tomorrow' });

    MailApp.sendEmail({
      to: to, // one recipient only
      subject: String(req.subject || '').slice(0, 250),
      body: String(req.text || ''),
      htmlBody: String(req.html || ''),
      name: String(req.name || 'GeoAttend').slice(0, 80),
      attachments: (req.attachments || []).map(function (a) {
        return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mimeType || 'application/octet-stream', a.name);
      })
    });
    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// Lets you open the /exec URL in a browser to check the deployment is live.
function doGet() {
  return reply({ ok: true, service: 'GeoAttend mail relay' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
