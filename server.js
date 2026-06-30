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

const API_KEY = process.env.SMART_API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.PIN;
const TOTP_SECRET = process.env.TOTP_SECRET;

async function doLogin(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    console.log('TOTP:', totp);
    const { SmartAPI } = require('smartapi-javascript');
    smartApi = new SmartAPI({ api_key: apiKey });
    const session = await smartApi.generateSession(clientCode, pin, totp);
    if (session.status) {
      sessionData = session.data;
      lastLogin = new Date();
      console.log('✅ Login successful');
      console.log('Available methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(smartApi)));
      return { success: true };
    }
    return { success: false, message: session.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

setInterval(async () => {
  if (API_KEY) await doLogin(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
}, 3 * 60 * 60 * 1000);

app.get('/', (req, res) => res.json({ status: 'running' }));

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
    
    // Try multiple method names depending on library version
    let data;
    if (typeof smartApi.getMarketData === 'function') {
      data = await smartApi.getMarketData({ mode: 'FULL', exchangeTokens: req.body.tokens });
    } else if (typeof smartApi.marketData === 'function') {
      data = await smartApi.marketData({ mode: 'FULL', exchangeTokens: req.body.tokens });
    } else if (typeof smartApi.getLTP === 'function') {
      data = await smartApi.getLTP({ exchangeTokens: req.body.tokens });
    } else {
      return res.json({ success: false, message: 'No quotes method found', availableMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(smartApi)) });
    }
    res.json({ success: true, data: data.data });
  } catch (err) { 
    res.json({ success: false, message: err.message }); 
  }
});

app.post('/api/option-chain', async (req, res) => {
  try {
    if (!smartApi) return res.json({ success: false, message: 'Not logged in' });
    res.json({ success: false, message: 'Option chain not yet wired - need correct method name' });
  } catch (err) { 
    res.json({ success: false, message: err.message }); 
  }
});

app.post('/api/candles', async (req, res) => {
  try {
    if (!smartApi) return res.json({ success: false, message: 'Not logged in' });
    let data;
    if (typeof smartApi.getCandleData === 'function') {
      data = await smartApi.getCandleData({ exchange: 'NSE', symboltoken: req.body.token, interval: req.body.interval, fromdate: req.body.fromDate, todate: req.body.toDate });
    } else if (typeof smartApi.candleData === 'function') {
      data = await smartApi.candleData({ exchange: 'NSE', symboltoken: req.body.token, interval: req.body.interval, fromdate: req.body.fromDate, todate: req.body.toDate });
    } else {
      return res.json({ success: false, message: 'No candle method found' });
    }
    res.json({ success: true, data: data.data });
  } catch (err) { 
    res.json({ success: false, message: err.message }); 
  }
});

// Debug endpoint - shows available SDK methods
app.get('/api/debug-methods', (req, res) => {
  if (!smartApi) return res.json({ message: 'Not logged in yet' });
  res.json({ 
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(smartApi))
  });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('TIIP Proxy running on port', PORT);
  if (API_KEY && CLIENT_CODE && PIN && TOTP_SECRET) {
    await doLogin(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
  }
});
