const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3099;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(path.join(__dirname, 'data/photos')));

// CORS — allow extension and any origin (extension is unpacked)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

fs.ensureDirSync('./data');
fs.ensureDirSync('./data/photos');

// SSE broadcast
let sseClients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => { try { r.write(msg); } catch {} });
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  // Heartbeat
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Ping (used by extension to verify server is reachable)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

// Extension connects — saves account cookies from browser session
app.post('/api/save-cookies', async (req, res) => {
  const { account, username, cookies } = req.body;
  if (!account || !username) return res.status(400).json({ error: 'Missing account or username' });

  await fs.writeJson(`./data/${account}-account.json`, { username, cookies: cookies || [], connectedAt: new Date().toISOString() });

  broadcast({ type: 'account', account, username, status: 'connected' });
  console.log(`✅ ${account} account connected: @${username}`);
  res.json({ ok: true, username });
});

// Get connected accounts
app.get('/api/accounts', async (req, res) => {
  const result = {};
  for (const acct of ['source', 'dest']) {
    try {
      const data = await fs.readJson(`./data/${acct}-account.json`);
      result[acct] = { username: data.username, connected: true, connectedAt: data.connectedAt };
    } catch {
      result[acct] = { connected: false };
    }
  }
  res.json(result);
});

// Get scraped listings
app.get('/api/listings', async (req, res) => {
  try { res.json(await fs.readJson('./data/listings.json')); }
  catch { res.json([]); }
});

// Start scraping source account
app.post('/api/scrape', async (req, res) => {
  res.json({ ok: true });
  const { scrapeAccount } = require('./scraper');
  try {
    const src = await fs.readJson('./data/source-account.json');
    await scrapeAccount(src.username, src.cookies || [], (p) => broadcast({ type: 'scrape', ...p }));
  } catch (err) {
    broadcast({ type: 'scrape', status: 'error', message: err.message });
  }
});

// Crosslist to destination
app.post('/api/crosslist', async (req, res) => {
  res.json({ ok: true });
  const { crosslistToAccount } = require('./poster');
  const { ids } = req.body;
  try {
    const dest = await fs.readJson('./data/dest-account.json');
    let listings = await fs.readJson('./data/listings.json');
    if (ids?.length) listings = listings.filter(l => ids.includes(l.id));
    await crosslistToAccount(dest.username, dest.cookies || [], listings, (p) => broadcast({ type: 'crosslist', ...p }));
  } catch (err) {
    broadcast({ type: 'crosslist', status: 'error', message: err.message });
  }
});

// Reset crosslist status
app.post('/api/reset', async (req, res) => {
  try {
    const listings = await fs.readJson('./data/listings.json');
    listings.forEach(l => { l.crosslisted = false; });
    await fs.writeJson('./data/listings.json', listings, { spaces: 2 });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// Delete all data
app.delete('/api/listings', async (req, res) => {
  await fs.remove('./data/listings.json');
  await fs.emptyDir('./data/photos');
  res.json({ ok: true });
});

// Disconnect an account
app.delete('/api/accounts/:acct', async (req, res) => {
  const { acct } = req.params;
  await fs.remove(`./data/${acct}-account.json`);
  broadcast({ type: 'account', account: acct, status: 'disconnected' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🏄  Riptag Crosslister`);
  console.log(`    Dashboard: http://localhost:${PORT}`);
  console.log(`    Extension: load /extension folder in Chrome\n`);
});

module.exports = app;
