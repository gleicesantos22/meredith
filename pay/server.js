// ===================
// CONFIGURATION
// ===================

// Required libraries and modules
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Redsys easy - using production URLs now
const {
  createRedsysAPI,
  PRODUCTION_URLS,
  randomTransactionId
} = require('redsys-easy');

// **** Production configuration ****
const MERCHANT_CODE = '367149531';
const TERMINAL = '1';
const SECRET_KEY = 'xdfHKzvmKSvUxPz91snmmjx14FpSWsU7';

// Callback URLs – using your Railway domain
const MERCHANT_MERCHANTURL = 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = 'https://yourdomain.com/error.html';

// Create the Redsys API with production URLs
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: PRODUCTION_URLS
});

// ===================
// DATABASE SETUP
// ===================
const db = new sqlite3.Database('./donations.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Create the donations table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS donations (
    orderId TEXT PRIMARY KEY,
    amount REAL
  )
`, (err) => {
  if (err) {
    console.error('Error creating donations table:', err.message);
  }
});

// ===================
// APP SETUP
// ===================
const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    callback(null, origin);
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'views')));

// ===================
// ROUTES
// ===================

// Serve the donation page (index.html)
app.get('/', (req, res, next) => {
  try {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  } catch (err) {
    next(err);
  }
});

// Endpoint to create a donation and store donor data in SQLite (only "amount" is required)
app.post('/create-donation', (req, res, next) => {
  const { amount } = req.body;
  if (!amount) {
    return res.status(400).json({ ok: false, error: 'Missing amount.' });
  }
  // Generate a unique order ID
  const orderId = randomTransactionId();
  // Insert donation data into SQLite
  db.run('INSERT INTO donations (orderId, amount) VALUES (?, ?)', [orderId, amount], function(err) {
    if (err) {
      console.error('Error inserting donation:', err.message);
      return res.status(500).json({ ok: false, error: 'Database error.' });
    }
    return res.json({ ok: true, orderId });
  });
});

// Endpoint to initiate Redsys payment via an iframe redirect
app.get('/iframe-sis', (req, res, next) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).send('<h1>Error: missing orderId param</h1>');
  }
  // Retrieve donation data from SQLite
  db.get('SELECT * FROM donations WHERE orderId = ?', [orderId], (err, row) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).send('<h1>Error: database error</h1>');
    }
    if (!row) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }
    // Convert amount to cents (Redsys expects an integer value in cents)
    const dsAmount = (parseFloat(row.amount) * 100).toFixed(0);
    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: dsAmount,
      DS_MERCHANT_CURRENCY: '978', // EUR
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      DS_MERCHANT_PERSOCODE: '1234',
      DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
      DS_MERCHANT_URLOK: MERCHANT_URLOK,
      DS_MERCHANT_URLKO: MERCHANT_URLKO
    };
    const form = createRedirectForm(params);
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Payment Redirect</title>
      </head>
      <body onload="document.forms[0].submit()">
        <h2>Please Wait...</h2>
        <form action="${form.url}" method="POST">
          <input type="hidden" name="Ds_SignatureVersion" value="${form.body.Ds_SignatureVersion}" />
          <input type="hidden" name="Ds_MerchantParameters" value="${form.body.Ds_MerchantParameters}" />
          <input type="hidden" name="Ds_Signature" value="${form.body.Ds_Signature}" />
        </form>
      </body>
      </html>
    `;
    res.send(html);
  });
});

// Redsys payment notification endpoint
app.post('/redsys-notification', (req, res, next) => {
  try {
    const result = processRedirectNotification(req.body);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      console.log('Payment SUCCESS, order:', result.Ds_Order);
      return res.send('OK');
    } else {
      console.log('Payment FAILED, order:', result.Ds_Order, 'code:', responseCode);
      return res.send('OK');
    }
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    next(err);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at https://fbcid-production.up.railway.app on port ${PORT}`);
});
