const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const MAX_HISTORY = 100;

const store = {
  sites: [
    { id: 'site-1', name: 'Clairtis', url: 'https://clairtis.fr', addedAt: new Date().toISOString() },
    { id: 'site-2', name: 'Avaya Clairtis', url: 'https://avaya.clairtis.fr', addedAt: new Date().toISOString() }
  ],
  history: {}
};

function generateId() {
  return 'site-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function checkSite(site) {
  const start = Date.now();
  const result = {
    timestamp: new Date().toISOString(),
    status: 'down',
    responseTime: null,
    statusCode: null,
    error: null,
    sslExpiry: null
  };

  return new Promise((resolve) => {
    try {
      const parsed = new URL(site.url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      let sslExpiry = null;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: (parsed.pathname || '/') + (parsed.search || ''),
        method: 'GET',
        timeout: 10000,
        headers: { 'User-Agent': 'Supervision-Bot/1.0' }
      };

      const req = lib.request(options, (res) => {
        result.responseTime = Date.now() - start;
        result.statusCode = res.statusCode;
        result.status = 'up';
        result.sslExpiry = sslExpiry;
        res.resume();
        resolve(result);
      });

      if (isHttps) {
        req.on('socket', (socket) => {
          socket.on('secureConnect', () => {
            try {
              const cert = socket.getPeerCertificate();
              if (cert && cert.valid_to) sslExpiry = new Date(cert.valid_to).toISOString();
            } catch (_) {}
          });
        });
      }

      req.on('timeout', () => {
        req.destroy();
        result.error = 'Timeout (10s)';
        result.responseTime = Date.now() - start;
        resolve(result);
      });

      req.on('error', (err) => {
        result.error = err.message;
        result.responseTime = Date.now() - start;
        resolve(result);
      });

      req.end();
    } catch (err) {
      result.error = err.message;
      resolve(result);
    }
  });
}

async function checkAllSites() {
  const results = await Promise.all(
    store.sites.map(async (site) => {
      const result = await checkSite(site);
      if (!store.history[site.id]) store.history[site.id] = [];
      store.history[site.id].unshift(result);
      if (store.history[site.id].length > MAX_HISTORY) store.history[site.id].length = MAX_HISTORY;
      return { siteId: site.id, ...result };
    })
  );
  console.log(`[${new Date().toISOString()}] Checked ${store.sites.length} sites`);
  return results;
}

function buildSiteResponse(site) {
  const history = store.history[site.id] || [];
  const latest = history[0] || null;
  const recent = history.slice(0, 20);

  const upCount = recent.filter(h => !h.error).length;
  const uptime = recent.length > 0 ? Math.round((upCount / recent.length) * 100) : null;

  const times = recent.filter(h => h.responseTime != null).map(h => h.responseTime);
  const avgResponseTime = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const minResponseTime = times.length > 0 ? Math.min(...times) : null;
  const maxResponseTime = times.length > 0 ? Math.max(...times) : null;

  // Last incident in full history
  const lastIncident = history.find(h => h.error != null) || null;

  // Incidents in recent 20 checks
  const recentIncidents = recent.filter(h => h.error != null).length;

  // Response time trend: recent 10 vs older 10
  let trend = null;
  if (recent.length >= 10) {
    const newHalf = recent.slice(0, 10).filter(h => h.responseTime != null).map(h => h.responseTime);
    const oldHalf = recent.slice(10, 20).filter(h => h.responseTime != null).map(h => h.responseTime);
    if (newHalf.length >= 3 && oldHalf.length >= 3) {
      const newAvg = newHalf.reduce((a, b) => a + b, 0) / newHalf.length;
      const oldAvg = oldHalf.reduce((a, b) => a + b, 0) / oldHalf.length;
      const pct = ((newAvg - oldAvg) / oldAvg) * 100;
      trend = pct > 10 ? 'degrading' : pct < -10 ? 'improving' : 'stable';
    }
  }

  return {
    ...site,
    latest,
    recentHistory: recent,
    uptime,
    avgResponseTime,
    minResponseTime,
    maxResponseTime,
    lastIncident,
    recentIncidents,
    trend,
    checksCount: history.length
  };
}

app.get('/api/sites', (_req, res) => {
  res.json(store.sites.map(buildSiteResponse));
});

app.post('/api/sites', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL requise' });

  let normalized = url.trim();
  if (!normalized.startsWith('http')) normalized = 'https://' + normalized;

  let hostname;
  try { hostname = new URL(normalized).hostname; }
  catch { return res.status(400).json({ error: 'URL invalide' }); }

  const site = {
    id: generateId(),
    name: (name && name.trim()) || hostname,
    url: normalized,
    addedAt: new Date().toISOString()
  };

  store.sites.push(site);
  const result = await checkSite(site);
  store.history[site.id] = [result];

  res.json(buildSiteResponse(site));
});

app.delete('/api/sites/:id', (req, res) => {
  const idx = store.sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Site introuvable' });
  store.sites.splice(idx, 1);
  delete store.history[req.params.id];
  res.json({ ok: true });
});

app.get('/api/sites/:id/history', (req, res) => {
  const history = store.history[req.params.id];
  if (!history) return res.status(404).json({ error: 'Site introuvable' });
  res.json(history);
});

app.post('/api/check', async (_req, res) => {
  const results = await checkAllSites();
  res.json(results);
});

app.get('/health', (_req, res) => res.json({ ok: true, sites: store.sites.length, uptime: process.uptime() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Supervision backend démarré sur le port ${PORT}`);
  checkAllSites();
  setInterval(checkAllSites, CHECK_INTERVAL_MS);
});
