const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const BASE_URL = 'https://apiconnect.angelone.in';
let jwtToken = null;
let lastLogin = null;
let instruments = null;
let instrumentsLoadedAt = null;

const API_KEY = process.env.SMART_API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.PIN;
const TOTP_SECRET = process.env.TOTP_SECRET;

function headers(apiKey, withAuth) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey
  };
  if (withAuth) h['Authorization'] = `Bearer ${jwtToken}`;
  return h;
}

async function login(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    const res = await fetch(`${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: headers(apiKey, false),
      body: JSON.stringify({ clientcode: clientCode, password: pin, totp })
    });
    const data = await res.json();
    if (data.status) {
      jwtToken = data.data.jwtToken;
      lastLogin = new Date();
      console.log('Login OK at', lastLogin);
      return { success: true };
    }
    console.log('Login failed:', data.message);
    return { success: false, message: data.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function loadInstruments() {
  try {
    console.log('Loading instrument master, this may take 10-20 seconds...');
    const res = await fetch('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
    instruments = await res.json();
    instrumentsLoadedAt = new Date();
    console.log('Instrument master loaded:', instruments.length, 'instruments');
  } catch (err) {
    console.log('Failed to load instrument master:', err.message);
  }
}

setInterval(() => {
  if (API_KEY) login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
}, 3 * 60 * 60 * 1000);

setInterval(loadInstruments, 24 * 60 * 60 * 1000);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: !!jwtToken,
    lastLogin,
    instrumentsLoaded: !!instruments,
    instrumentCount: instruments ? instruments.length : 0,
    instrumentsLoadedAt
  });
});

app.post('/api/login', async (req, res) => {
  const { apiKey, clientCode, pin, totpSecret } = req.body;
  res.json(await login(apiKey, clientCode, pin, totpSecret));
});

app.post('/api/quotes', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    const r = await fetch(`${BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: headers(API_KEY, true),
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: req.body.tokens })
    });
    const data = await r.json();
    res.json({ success: data.status, data: data.data, message: data.message });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/expiries/:symbol', async (req, res) => {
  try {
    if (!instruments) {
      return res.json({ success: false, message: 'Instruments still loading, try again in 20 seconds' });
    }
    const symbol = req.params.symbol.toUpperCase();
    const matches = instruments.filter(inst =>
      inst.name === symbol && inst.instrumenttype === 'OPTIDX'
    );
    const expirySet = new Set(matches.map(m => m.expiry));
    const expiries = Array.from(expirySet).sort();
    res.json({ success: true, symbol, expiries, count: matches.length });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/option-chain/:symbol/:expiry', async (req, res) => {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    if (!instruments) {
      return res.json({ success: false, message: 'Instruments still loading, try again in 20 seconds' });
    }

    const symbol = req.params.symbol.toUpperCase();
    const expiry = req.params.expiry.toUpperCase();

    const matches = instruments.filter(inst =>
      inst.name === symbol &&
      inst.expiry === expiry &&
      inst.instrumenttype === 'OPTIDX'
    );

    if (matches.length === 0) {
      return res.json({
        success: false,
        message: 'No instruments found',
        symbol,
        expiry,
        hint: 'Check /api/expiries/' + symbol + ' for valid expiry format'
      });
    }

    const tokens = matches.map(m => m.token);
    const batches = [];
    for (let i = 0; i < tokens.length; i += 50) {
      batches.push(tokens.slice(i, i + 50));
    }

    let allQuotes = [];
    for (const batch of batches) {
      const r = await fetch(`${BASE_URL}/rest/secure/angelbroking/market/v1/quote/`, {
        method: 'POST',
        headers: headers(API_KEY, true),
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: batch } })
      });
      const data = await r.json();
      if (data.status && data.data && data.data.fetched) {
        allQuotes = allQuotes.concat(data.data.fetched);
      }
    }

    const chain = allQuotes.map(quote => {
      const inst = matches.find(m => m.token === quote.symbolToken);
      return {
        strike: inst ? parseFloat(inst.strike) / 100 : null,
        type: inst ? (inst.symbol.endsWith('CE') ? 'CE' : 'PE') : null,
        symbol: quote.tradingSymbol,
        token: quote.symbolToken,
        ltp: quote.ltp,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        change: quote.netChange,
        changePct: quote.percentChange,
        oi: quote.opnInterest,
        volume: quote.tradeVolume
      };
    });

    res.json({ success: true, symbol, expiry, strikeCount: chain.length, data: chain });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('Proxy running on', PORT);
  if (API_KEY) await login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
  loadInstruments();
});
