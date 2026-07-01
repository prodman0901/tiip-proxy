const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const BASE_URL = 'https://apiconnect.angelone.in';
let jwtToken = null;
let feedToken = null;
let lastLogin = null;
let instruments = null;
let instrumentsLoadedAt = null;

const API_KEY = process.env.SMART_API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.PIN;
const TOTP_SECRET = process.env.TOTP_SECRET;

function makeHeaders(apiKey, withAuth) {
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
  if (withAuth) {
    h['Authorization'] = 'Bearer ' + jwtToken;
    if (feedToken) h['X-FeedToken'] = feedToken;
  }
  return h;
}

async function login(apiKey, clientCode, pin, totpSecret) {
  try {
    const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    console.log('Logging in, TOTP:', totp);
    const res = await fetch(BASE_URL + '/rest/auth/angelbroking/user/v1/loginByPassword', {
      method: 'POST',
      headers: makeHeaders(apiKey, false),
      body: JSON.stringify({ clientcode: clientCode, password: pin, totp: totp })
    });
    const data = await res.json();
    if (data.status) {
      jwtToken = data.data.jwtToken;
      feedToken = data.data.feedToken;
      lastLogin = new Date();
      console.log('Feed token present:', !!feedToken);
      console.log('Login OK at', lastLogin);
      return { success: true };
    }
    console.log('Login failed:', data.message);
    return { success: false, message: data.message };
  } catch (err) {
    console.log('Login error:', err.message);
    return { success: false, message: err.message };
  }
}

function loadInstruments() {
  try {
    console.log('Loading instrument master from disk...');
    const filePath = path.join(__dirname, 'instruments.json');
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      instruments = JSON.parse(text);
      instrumentsLoadedAt = new Date();
      console.log('Instruments loaded:', instruments.length);
    } else {
      console.log('instruments.json not found');
    }
  } catch (err) {
    console.log('Instrument load failed:', err.message);
  }
}

setInterval(function() {
  if (API_KEY) login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
}, 3 * 60 * 60 * 1000);

app.get('/api/health', function(req, res) {
  res.json({
    status: 'ok',
    connected: !!jwtToken,
    lastLogin: lastLogin,
    instrumentsLoaded: !!instruments,
    instrumentCount: instruments ? instruments.length : 0,
    instrumentsLoadedAt: instrumentsLoadedAt
  });
});

app.post('/api/login', async function(req, res) {
  const result = await login(req.body.apiKey, req.body.clientCode, req.body.pin, req.body.totpSecret);
  res.json(result);
});

app.post('/api/quotes', async function(req, res) {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    const r = await fetch(BASE_URL + '/rest/secure/angelbroking/market/v1/quote/', {
      method: 'POST',
      headers: makeHeaders(API_KEY, true),
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: req.body.tokens })
    });
    console.log('HTTP Status:', r.status);
    console.log('HTTP Status:', r.status);
    const data = await r.json();
    console.log(JSON.stringify(data, null, 2));
    console.log('First instrument:', matches[0]);
    console.log(JSON.stringify(data, null, 2));
    res.json({ success: data.status, data: data.data, message: data.message });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/debug/:symbol', function(req, res) {
  if (!instruments) return res.json({ message: 'not loaded' });
  const symbol = req.params.symbol.toUpperCase();
  const matches = instruments.filter(function(inst) {
    return inst.name === symbol;
  }).slice(0, 5);
  res.json({ sample: matches });
});

app.get('/api/expiries/:symbol', function(req, res) {
  if (!instruments) return res.json({ success: false, message: 'Instruments not loaded' });
  const symbol = req.params.symbol.toUpperCase();
  const matches = instruments.filter(function(inst) {
    return inst.name === symbol && inst.instrumenttype === 'OPTIDX';
  });
  const expirySet = new Set(matches.map(function(m) { return m.expiry; }));
  const expiries = Array.from(expirySet).sort();
  res.json({ success: true, symbol: symbol, expiries: expiries, count: matches.length });
});

app.get('/api/option-chain/:symbol/:expiry', async function(req, res) {
  try {
    if (!jwtToken) return res.json({ success: false, message: 'Not logged in' });
    if (!instruments) return res.json({ success: false, message: 'Instruments not loaded' });

    const symbol = req.params.symbol.toUpperCase();
    const expiry = req.params.expiry.toUpperCase();

    const matches = instruments.filter(function(inst) {
      return inst.name === symbol &&
             inst.expiry === expiry &&
             inst.instrumenttype === 'OPTIDX';
    });

    if (matches.length === 0) {
      return res.json({
        success: false,
        message: 'No instruments found for ' + symbol + ' ' + expiry,
        hint: 'Check /api/expiries/' + symbol + ' for valid expiry dates'
      });
    }

    console.log('Found', matches.length, 'instruments for', symbol, expiry);

    const tokens = matches.slice(0, 50).map(function(m) { return m.token; });
    console.log('Sample tokens:', tokens.slice(0, 3));

    const r = await fetch(BASE_URL + '/rest/secure/angelbroking/market/v1/quote/', {
      method: 'POST',
      headers: makeHeaders(API_KEY, true),
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: tokens } })
    });
    const data = await r.json();

    console.log('Quote status:', data.status, 'message:', data.message);
    console.log('Fetched:', data.data && data.data.fetched ? data.data.fetched.length : 0);
    console.log('Unfetched:', data.data && data.data.unfetched ? data.data.unfetched.length : 0);

    if (!data.status) {
      return res.json({
        success: false,
        message: data.message,
        errorcode: data.errorcode,
        debug: {
          instrumentsFound: matches.length,
          tokensSent: tokens.length,
          sampleTokens: tokens.slice(0, 3)
        }
      });
    }

    let allQuotes = data.data.fetched || [];

    const remaining = matches.slice(50);
    for (let i = 0; i < remaining.length; i += 50) {
      const batch = remaining.slice(i, i + 50).map(function(m) { return m.token; });
      const br = await fetch(BASE_URL + '/rest/secure/angelbroking/market/v1/quote/', {
        method: 'POST',
        headers: makeHeaders(API_KEY, true),
        body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: batch } })
      });
      const bdata = await br.json();
      if (bdata.status && bdata.data && bdata.data.fetched) {
        allQuotes = allQuotes.concat(bdata.data.fetched);
      }
    }

    const chain = allQuotes.map(function(quote) {
      const inst = matches.find(function(m) { return m.token === quote.symbolToken; });
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

    res.json({
      success: true,
      symbol: symbol,
      expiry: expiry,
      instrumentsFound: matches.length,
      strikeCount: chain.length,
      data: chain
    });

  } catch (err) {
    console.log('Option chain error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', async function() {
  console.log('Proxy running on port', PORT);
  if (API_KEY && CLIENT_CODE && PIN && TOTP_SECRET) {
    await login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
  }
  loadInstruments();
});
