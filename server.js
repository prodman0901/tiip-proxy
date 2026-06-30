const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Accept'] }));
app.options('*', cors());
app.use(express.json());

const BASE_URL = 'https://apiconnect.angelone.in';

let jwtToken = null;
let refreshToken = null;
let feedToken = null;
let lastLogin = null;

const API_KEY = process.env.SMART_API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.PIN;
const TOTP_SECRET = process.env.TOTP_SECRET;

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey
  };
}

async function doLogin(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    console.log('TOTP generated:', totp);

    const response = await fetch(
      `${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          clientcode: clientCode,
          password: pin,
          totp: totp
        })
      }
    );
    const data = await response.json();

    if (data.status) {
      jwtToken = data.data.jwtToken;
      refreshToken = data.data.refreshToken;
      feedToken = data.data.feedToken;
      lastLogin = new Date();
      console.log('✅ Login successful at', lastLogin);
      return { success: true };
    }
    console.log('❌ Login failed:', data.message);
    return { success: false, message: data.message };
  } catch (err) {
    console.log('❌ Error:', err.message);
    return { success: false, message: err.message };
  }
}

async function apiCall(endpoint, method, body, apiKey) {
  const headers = {
    ...authHeaders(apiKey),
    'Authorization': `Bearer ${jwtToken}`
  };
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

setInterval(async () => {
  if (API_KEY) {
    console.log('⏰ Re-login...');
    await doLogin(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
  }
}, 3 * 60 * 60 * 1000);

app.get('/', (req, res) => res.json({ status: 'running' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: !!jwtToken,
    lastLogin,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/login', async (req, res) => {
  const { apiKey, clientCode, pin, totpSecret } = req.body;
  const result = await doLogin(apiKey, clientCode, pin, totpSecret);
  res.json(result);
});

// Live quotes
app.post('/api/quotes', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    const data = await apiCall(
      '/rest/secure/angelbroking/market/v1/quote/',
      'POST',
      {
        mode: 'FULL',
        exchangeTokens: req.body.tokens
      },
      API_KEY
    );
    res.json({ success: data.status, data: data.data, message: data.message });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Option chain via instrument search + quotes
app.post('/api/option-chain', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    // SmartAPI doesn't have a direct option chain endpoint
    // Need to fetch instrument master + filter + get quotes
    res.json({ success: false, message: 'Use instrument master + quotes approach' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Historical candles
app.post('/api/candles', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    const data = await apiCall(
      '/rest/secure/angelbroking/historical/v1/getCandleData',
      'POST',
      {
        exchange: req.body.exchange || 'NSE',
        symboltoken: req.body.token,
        interval: req.body.interval,
        fromdate: req.body.fromDate,
        todate: req.body.toDate
      },
      API_KEY
    );
    res.json({ success: data.status, data: data.data, message: data.message });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('TIIP Proxy running on port', PORT);
  if (API_KEY && CLIENT_CODE && PIN && TOTP_SECRET) {
    await doLogin(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
  }
});

// ── INSTRUMENT MASTER (cached) ───────────────────
let instrumentMaster = null;
let instrumentMasterFetchedAt = null;

async function loadInstrumentMaster() {
  try {
    console.log('Loading instrument master...');
    const response = await fetch(
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'
    );
    instrumentMaster = await response.json();
    instrumentMasterFetchedAt = new Date();
    console.log('✅ Instrument master loaded:', instrumentMaster.length, 'instruments');
  } catch (err) {
    console.log('❌ Failed to load instrument master:', err.message);
  }
}

// Refresh instrument master daily
setInterval(loadInstrumentMaster, 24 * 60 * 60 * 1000);

app.get('/api/option-chain-v2/:symbol/:expiry', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    if (!instrumentMaster) await loadInstrumentMaster();

    const symbol = req.params.symbol.toUpperCase();
    const expiry = req.params.expiry.toUpperCase(); // e.g. 26JUN2025

    // Filter instrument master for matching options
    const matches = instrumentMaster.filter(inst =>
      inst.name === symbol &&
      inst.expiry === expiry &&
      (inst.symbol.endsWith('CE') || inst.symbol.endsWith('PE'))
    );

    if (matches.length === 0) {
      return res.json({ success: false, message: 'No matching instruments found', symbol, expiry });
    }

    // Get tokens for quotes call
    const tokens = matches.map(m => m.token);

    const quotesData = await apiCall(
      '/rest/secure/angelbroking/market/v1/quote/',
      'POST',
      { mode: 'FULL', exchangeTokens: { NFO: tokens } },
      API_KEY
    );

    res.json({
      success: true,
      symbol,
      expiry,
      instrumentCount: matches.length,
      data: quotesData.data
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});
