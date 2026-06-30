const express = require('express');
const cors = require('cors');
const speakeasy = require('speakeasy');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const BASE_URL = 'https://apiconnect.angelone.in';
let jwtToken = null;
let lastLogin = null;

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
      console.log('✅ Login OK');
      return { success: true };
    }
    console.log('❌', data.message);
    return { success: false, message: data.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

setInterval(() => {
  if (API_KEY) login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
}, 3 * 60 * 60 * 1000);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', connected: !!jwtToken, lastLogin });
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

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Proxy running on', PORT);
  if (API_KEY) login(API_KEY, CLIENT_CODE, PIN, TOTP_SECRET);
});
