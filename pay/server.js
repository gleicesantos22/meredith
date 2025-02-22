// ===================
// CONFIGURATION
// ===================

// Required libraries and modules
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

// Redsys easy - using production URLs now
const {
  createRedsysAPI,
  PRODUCTION_URLS, // switched from SANDBOX_URLS to PRODUCTION_URLS for production deployment
  randomTransactionId
} = require('redsys-easy');

// **** Update the following configuration values for your production environment ****
const MERCHANT_CODE = '367149531'; 
const TERMINAL = '1';
const SECRET_KEY = 'xdfHKzvmKSvUxPz91snmmjx14FpSWsU7';

// Callback URLs – update these with your production domain
const MERCHANT_MERCHANTURL = 'https://yourdomain.com/redsys-notification';
const MERCHANT_URLOK = 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = 'https://yourdomain.com/error.html';

// Create the Redsys API with production URLs
const {
  createRedirectForm,
  processRedirectNotification,
} = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: PRODUCTION_URLS
});

// ===================
// APP SETUP
// ===================
const app = express();

// Allow CORS from any origin with credentials support
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // Reflect the request origin
    callback(null, origin);
  },
  credentials: true
}));

// Parse application/json and application/x-www-form-urlencoded
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'views')));

// ===================
// ROUTES
// ===================

// Landing page for donation (can be accessed as /donate.html directly as well)
app.get('/', (req, res, next) => {
  try {
    res.sendFile(path.join(__dirname, 'views', 'donate.html'));
  } catch (err) {
    next(err);
  }
});

// Endpoint to create a donation and store donor info in a cookie
app.post('/create-donation', (req, res, next) => {
  try {
    const { amount, firstName, lastName, email } = req.body;
    if (!amount || !firstName || !lastName || !email) {
      return res.status(400).json({ ok: false, error: 'Missing fields.' });
    }
    // Generate a unique order ID
    const orderId = randomTransactionId();

    // Store donor data
    const donor = { amount, firstName, lastName, email, orderId };
    res.cookie(`donor_${orderId}`, JSON.stringify(donor), {
      maxAge: 30 * 60 * 1000, // 30 minutes
      sameSite: 'none',       // Allow cross-site requests
      secure: true            // Must be true for SameSite 'none'
    });

    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error in /create-donation:', err);
    next(err);
  }
});

app.get('/iframe-sis', (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    // Retrieve donor data from the cookie
    const donorCookie = req.cookies[`donor_${orderId}`];
    if (!donorCookie) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }
    const donor = JSON.parse(donorCookie);

    // Convert amount to cents
    const dsAmount = (parseInt(donor.amount, 10) * 100).toString();

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
        <h2 style="font-size:16px;">Please Wait...</h2>
        <form action="${form.url}" method="POST">
          <input type="hidden" name="Ds_SignatureVersion" value="${form.body.Ds_SignatureVersion}" />
          <input type="hidden" name="Ds_MerchantParameters" value="${form.body.Ds_MerchantParameters}" />
          <input type="hidden" name="Ds_Signature" value="${form.body.Ds_Signature}" />
        </form>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error('Error in /iframe-sis:', err);
    next(err);
  }
});

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

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
