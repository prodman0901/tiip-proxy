const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Accept'] }));
app.options('*', cors());
app.use(express.json());

let smartApi = null;
let sessionData = null;
let lastLogin = null;
let credentials = null;

async function doLogin(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    console.log('TOTP generated:', totp);
    const { SmartAPI } = require('smartapi-javascript');
    smartApi = new SmartAPI({ api_key: apiKey });
    const session = await smartApi.generateSession(clientCode, pin, totp);
    if (session.status) {
      sessionData = session.data;
      lastLogin = new Date();
      credentials = { apiKey, clientCode, pin, totpSecret };
      console.log('✅ Login successful at', lastLogin);
      return { success: true };
    }
    console.log('❌ Login failed:', session.message);
    return { success: false, message: session.message };
  } catch (err) {
    console.log('❌ Error:', err.message);
    return { success: false, message: err.message };
  }
}

// Auto-login on startup if env vars are set
async function startupLogin() {
  const apiKey = process.env.SMART_API_KEY;
  const clientCode = process.env.CLIENT_CODE;
  const pin = process.env.PIN;
  const totpSecret = process.env.TOTP_SECRET;
  if (apiKey && clientCode && pin && totpSecret) {
    console.log('Auto-login on startup...');
    await doLogin(apiKey, clientCode, pin, totpSecret);
  } else {
    console.log('No env credentials — waiting for manual login');
  }
}

// Re-login every 4 hours
setInterval(async () => {
  const creds = credentials || {
    apiKey: process.env.SMART_API_KEY,
    clientCode: process.env.CLIENT_CODE,
    pin: process.env.PIN,
    totpSecret: process.env.TOTP_SECRET
  };
  if (creds.apiKey) {
    console.log('Auto re-login...');
    await doLogin(creds.apiKey, creds.clientCode, creds.pin, creds.totpSecret);
  }
}, 4 * 60 * 60 * 1000);

app.get('/', (req, res) => res.json({ name: 'TIIP Proxy', status: 'running' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', connected: !!sessionData, lastLogin, timestamp: new Date().toISOString() });
});

app.post('/api/login', async (req, res) => {
  const { apiKey, clientCode, pin, totpSecret } = req.body;
  const result = await doLogin(apiKey, clientCode, pin, totpSecret);
  res.json(result);
});

app.post('/api/quotes', async (req, res) => {
  try {
    if (!smartApi) return res.json({ success: false, message: 'Not logged in' });
    const data = await smartApi.getMarketData({ mode: 'FULL', exchangeTokens: req.body.tokens });
    res.json({ success: true, data: data.data });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/option-chain', async (req, res) => {
  try {
    if (!smartApi) return res.json({ success: false, message: 'Not logged in' });
    const data = await smartApi.getOptionChainDetails({ tradingsymbol: req.body.symbol, expiry: req.body.expiry });
    res.json({ success: true, data: data.data });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/candles', async (req, res) => {
  try {
    if (!smartApi) return res.json({ success: false, message: 'Not logged in' });
    const data = await smartApi.getCandleData({ exchange: 'NSE', symboltoken: req.body.token, interval: req.body.interval, fromdate: req.body.fromDate, todate: req.body.toDate });
    res.json({ success: true, data: data.data });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('TIIP Proxy running on port', PORT);
  await startupLogin();
});
