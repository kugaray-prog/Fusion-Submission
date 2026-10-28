// Dev-only browser reload via EventSource at /__livereload: on views/ or public/
// changes (polled) and on server restart (new boot id).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WATCH_DIRS = ['views', 'public'].map((d) => path.join(ROOT, d));
const SKIP = new Set(['downloads']);
const INTERVAL = 700;

const BOOT_ID = Date.now().toString(36);
const clients = new Set();

const CLIENT_SCRIPT = `<script>
(function () {
  var boot = null;
  var es = new EventSource('/__livereload');
  es.addEventListener('hello', function (e) {
    if (boot && boot !== e.data) location.reload();
    boot = e.data;
  });
  es.addEventListener('reload', function () { location.reload(); });
})();
</script>`;

function snapshot(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      snapshot(full, out);
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        out.set(full, `${st.mtimeMs}:${st.size}`);
      } catch (e) {
      }
    }
  }
  return out;
}

function takeSnapshot() {
  const out = new Map();
  WATCH_DIRS.forEach((dir) => snapshot(dir, out));
  return out;
}

function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [file, stamp] of a) {
    if (b.get(file) !== stamp) return false;
  }
  return true;
}

function startPolling() {
  let known = takeSnapshot();
  setInterval(() => {
    const current = takeSnapshot();
    if (sameSnapshot(known, current)) return;
    known = current;
    console.log('[livereload] views/public changed, reloading browsers');
    clients.forEach((res) => res.write('event: reload\ndata: 1\n\n'));
  }, INTERVAL).unref();
}

function mount(app) {
  app.get('/__livereload', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write('retry: 500\n');
    res.write(`event: hello\ndata: ${BOOT_ID}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Inject the client script into every HTML response sent with res.send
  // (which is what res.render ends in).
  app.use((req, res, next) => {
    const send = res.send;
    res.send = function (body) {
      if (typeof body === 'string' && /html/.test(res.get('Content-Type') || 'text/html') && body.includes('</body>')) {
        body = body.replace(/<\/body>(?![\s\S]*<\/body>)/, `${CLIENT_SCRIPT}</body>`);
      }
      return send.call(this, body);
    };
    next();
  });

  startPolling();
  console.log('Live reload: ENABLED (development mode)');
}

module.exports = { mount };
