const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');
const { SmartAPI } = require('smartapi-javascript');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

let smartApi = null;
let sessionData = null;
let lastLogin = null;
let credentials = null;

async function doLogin(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    smartApi = new SmartAPI({ api_key: apiKey });
    const session = await smartApi.generateSession(clientCode, pin, totp);
    if (session.status) {
      sessionData = session.data;
      lastLogin = new Date();
      credentials = { apiKey, clientCode, pin, totpSecret };
      console.log('Login successful at', lastLogin);
      return { success: true };
    }
    return { success: false, message: session.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

setInterval(async () => {
  if (credentials) await doLogin(credentials.apiKey, credentials.clientCode, credentials.pin, credentials.totpSecret);
}, 6 * 60 * 60 * 1000);

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
app.listen(PORT, () => console.log('TIIP Proxy running on port', PORT));
