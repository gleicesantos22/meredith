/********************************
 * server.js
 ********************************/
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const crypto = require('crypto');

// Required libraries for Redsys integration
const { createRedsysAPI, SANDBOX_URLS, PRODUCTION_URLS, randomTransactionId } = require('redsys-easy');


function extractFbclidFromFbc(fbc) {
    try {
        const parts = fbc.split('.');
        if (parts.length >= 4) {
            const fbclidExtracted = parts.slice(3).join('.');
            // Optional: Validate that the fbclid is alphanumeric (with possible underscores or hyphens)
            if (/^[A-Za-z0-9_-]+$/.test(fbclidExtracted)) {
                return fbclidExtracted;
            }
            return fbclidExtracted;
        }
    } catch (err) {
        console.error('[FB Data] Error extracting fbclid from fbc:', err);
    }
    return null;
}

// Generate fbc from fbclid using current timestamp (always in the format fb.1.<timestamp>.<fbclid>)
function generateFbc(fbclid) {
    const timestamp = Math.floor(Date.now() / 1000);
    return `fb.1.${timestamp}.${fbclid}`;
}

// Generate a new fbp value if missing
function generateFbp() {
    const timestamp = Math.floor(Date.now() / 1000);
    const randomComponent = Math.floor(Math.random() * 1e15); // Large random number
    return `fb.1.${timestamp}.${randomComponent}`;
}

// Retrieve the two-letter country code (ISO 3166-1 alpha-2) using a public API (ip-api.com)
async function getCountryFromIP(ip) {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`http://ip-api.com/json/${ip}`);
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        if (data.status === "success" && data.countryCode) {
            return data.countryCode; // Returns the two-letter country code, e.g., "US"
        }
    } catch (err) {
        console.error('[FB Data] Error fetching country from IP:', err);
    }
    return null;
}

// ------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '1';
// Changed to production secret key
const SECRET_KEY = process.env.SECRET_KEY || 'xdfHKzvmKSvUxPz91snmmjx14FpSWsU7';

const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || '/thanks';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || '/error';

// Set environment to production by default
const REDSYS_ENVIRONMENT = process.env.REDSYS_ENVIRONMENT || 'production';

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------
// MIDDLEWARE SETUP
// ------------------------------------------------------
app.use(cors({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false // No credentials needed since we're using localStorage
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global logging middleware for all incoming requests
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.url} - Query: ${JSON.stringify(req.query)} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------
// SQLITE SETUP
// ------------------------------------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});
const dbAll = promisify(db.all).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbRun = (...args) => {
    return new Promise((resolve, reject) => {
        db.run(...args, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

// Create / alter tables as needed
db.serialize(() => {
    // donations table
    db.run(
        `CREATE TABLE IF NOT EXISTS donations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE,
            donation_amount INTEGER,
            fbclid TEXT,
            fb_conversion_sent INTEGER DEFAULT 0,
            client_ip_address TEXT,
            client_user_agent TEXT,
            fbp TEXT,
            fbc TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('[DB] Error creating donations table:', err);
            } else {
                console.log('[DB] Donations table is ready.');
            }
        }
    );

    // fb_conversion_logs table
    db.run(
        `CREATE TABLE IF NOT EXISTS fb_conversion_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            donation_id INTEGER,
            raw_payload TEXT,
            attempts INTEGER DEFAULT 0,
            last_attempt DATETIME,
            status TEXT DEFAULT 'pending',
            error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('[DB] Error creating fb_conversion_logs table:', err);
            } else {
                console.log('[DB] fb_conversion_logs table is ready.');
            }
        }
    );

    // payment_failures table
    db.run(
        `CREATE TABLE IF NOT EXISTS payment_failures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT,
            amount INTEGER,
            error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('[DB] Error creating payment_failures table:', err);
            } else {
                console.log('[DB] payment_failures table is ready.');
            }
        }
    );
});

// ------------------------------------------------------
// REDSYS SETUP
// ------------------------------------------------------
const redsysEnvUrls = REDSYS_ENVIRONMENT === 'production' ? PRODUCTION_URLS : SANDBOX_URLS;
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
    secretKey: SECRET_KEY,
    urls: redsysEnvUrls
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API (Updated with new logging)
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
    try {
        const fetch = (await import('node-fetch')).default;

        // -----------------------------
        // Update donationRow with missing values:
        // -----------------------------
        if (!donationRow.fbclid && donationRow.fbc) {
            donationRow.fbclid = extractFbclidFromFbc(donationRow.fbc);
            console.log('[FB Conversion] Extracted fbclid from fbc:', donationRow.fbclid);
        }
        if (!donationRow.fbc && donationRow.fbclid) {
            donationRow.fbc = generateFbc(donationRow.fbclid);
            console.log('[FB Conversion] Generated fbc from fbclid:', donationRow.fbc);
        }
        if (!donationRow.fbp) {
            donationRow.fbp = generateFbp();
            console.log('[FB Conversion] Generated new fbp:', donationRow.fbp);
        }
        // Get country code from IP address (if available)
        let country = null;
        if (donationRow.client_ip_address) {
            country = await getCountryFromIP(donationRow.client_ip_address);
            console.log('[FB Conversion] Country code from IP:', country);
        }

        // -----------------------------
        // Prepare the user_data object for FB event.
        // IMPORTANT: fbclid is NOT sent directly.
        // -----------------------------
        const userData = {};
        if (donationRow.fbp) userData.fbp = donationRow.fbp;
        if (donationRow.fbc) userData.fbc = donationRow.fbc;
        if (donationRow.client_ip_address) userData.client_ip_address = donationRow.client_ip_address;
        if (donationRow.client_user_agent) userData.client_user_agent = donationRow.client_user_agent;
        if (country) {
            try {
                userData.country = crypto.createHash('sha256').update(country.toLowerCase()).digest('hex');
            } catch (err) {
                console.error('[FB Data] Error hashing country:', err);
            }
        }

        console.log('[FB Conversion] User data prepared:', userData);

        const eventSourceUrl = 'http://ituberus.github.io/fbcid/thanks.html'; // Adjust if necessary
        const finalEventId = donationRow.order_id || String(donationRow.id);

        // -----------------------------
        // Prepare event data as required by Facebook Conversions API
        // -----------------------------
        const eventData = {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: finalEventId,
            event_source_url: eventSourceUrl,
            action_source: 'website',
            user_data: userData,
            custom_data: {
                value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
                currency: 'EUR'
            },
        };

        // Log the eventData before sending
        console.log('[FB Conversion] Event data prepared to be sent:', JSON.stringify(eventData, null, 2));

        const payload = {
            data: [eventData],
        };

        if (FACEBOOK_TEST_EVENT_CODE) {
            payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
        }

        // Log the complete payload
        console.log('[FB Conversion] Complete payload to be sent:', JSON.stringify(payload, null, 2));

        const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;

        // -----------------------------
        // Send the event to Facebook
        // -----------------------------
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
        });

        // Log the raw response from Facebook
        const responseText = await response.text();
        console.log('[FB Conversion] Raw response from Facebook:', responseText);

        if (!response.ok) {
            console.error('[FB Conversion] Error response from FB:', response.status, responseText);
            throw new Error(`FB API error: ${response.status} - ${responseText}`);
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            console.error('[FB Conversion] Failed to parse JSON response from FB:', e);
            throw e;
        }
        console.log('[FB Conversion] Facebook conversion result:', result);
        return { success: true, result };
    } catch (err) {
        console.error('[FB Conversion] Error in sendFacebookConversionEvent:', err);
        throw err;
    }
}

// ------------------------------------------------------
// Retry mechanism for Facebook Conversion
// ------------------------------------------------------
async function attemptFacebookConversion(donationRow) {
    const maxAttempts = 3;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxAttempts) {
        try {
            console.log(`[FB Conversion] Attempt ${attempt + 1} for donation id ${donationRow.id}`);
            const result = await sendFacebookConversionEvent(donationRow);
            if (result.success) {
                console.log(`[FB Conversion] Success on attempt ${attempt + 1} for donation id ${donationRow.id}`);
                return { success: true, result, attempts: attempt + 1 };
            }
            lastError = new Error(result.error || 'Unknown error');
        } catch (err) {
            lastError = err;
            console.error(`[FB Conversion] Attempt ${attempt + 1} failed:`, err.message);
        }
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
    console.error(`[FB Conversion] All attempts failed for donation id ${donationRow.id}`);
    return { success: false, error: lastError, attempts: attempt };
}

// ------------------------------------------------------
// ROUTES
// ------------------------------------------------------

// Endpoint to create a donation and store donor data in SQLite
app.post('/create-donation', async (req, res) => {
    try {
        const { amount, fbclid, fbp, fbc } = req.body;
        console.log('[Create Donation] Received donation request:', { amount, fbclid, fbp, fbc });

        if (!amount) {
            console.error('[Create Donation] Missing donation amount.');
            return res.status(400).json({ error: 'Missing donation amount.' });
        }

        // Generate a unique order ID
        const orderId = randomTransactionId();
        console.log('[Create Donation] Generated order ID:', orderId);

        // Get client IP and user agent
        const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
        const clientUserAgent = req.headers['user-agent'] || '';
        console.log('[Create Donation] Client info:', { clientIp, clientUserAgent });

        // Convert amount to cents (assuming amount in Euros)
        const amountCents = Math.round(Number(amount) * 100);
        if (isNaN(amountCents) || amountCents <= 0) {
            console.error('[Create Donation] Invalid donation amount:', amount);
            return res.status(400).json({ error: 'Invalid donation amount.' });
        }
        console.log('[Create Donation] Donation amount in cents:', amountCents);

        // Insert donation data into SQLite
        await dbRun(
            `INSERT INTO donations (
                order_id,
                donation_amount,
                fbclid,
                fbp,
                fbc,
                client_ip_address,
                client_user_agent,
                fb_conversion_sent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderId,
                amountCents,
                fbclid || null,
                fbp || null,
                fbc || null,
                clientIp,
                clientUserAgent,
                0,
            ]
        );
        console.log('[Create Donation] Donation data saved in DB for order ID:', orderId);

        // Generate the parameters for Redsys
        const params = {
            DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
            DS_MERCHANT_TERMINAL: TERMINAL,
            DS_MERCHANT_ORDER: orderId,
            DS_MERCHANT_AMOUNT: amountCents,
            DS_MERCHANT_CURRENCY: '978', // EUR
            DS_MERCHANT_TRANSACTIONTYPE: '0',
            DS_MERCHANT_CONSUMERLANGUAGE: '2',
            DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
            DS_MERCHANT_URLOK: MERCHANT_URLOK,
            DS_MERCHANT_URLKO: MERCHANT_URLKO,
            Ds_Merchant_PersoCode: '1'
        };
        let form;
        try {
            form = createRedirectForm(params);
        } catch (err) {
            console.error('[Create Donation] Error creating Redsys form:', err);
            return res.status(500).json({ error: 'Error generating payment form.' });
        }
        console.log('[Create Donation] Redsys form generated for order ID:', orderId);

        // Return the orderId along with the form data
        res.json({ ok: true, orderId, form });
    } catch (err) {
        console.error('[Create Donation] Error in /create-donation:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Endpoint to initiate Redsys payment via an iframe redirect
app.get('/iframe-sis', async (req, res, next) => {
    try {
        const { orderId } = req.query;
        console.log('[Iframe Redirect] Request received for order ID:', orderId);

        if (!orderId) {
            console.error('[Iframe Redirect] Missing orderId parameter.');
            return res.status(400).send('<h1>Error: missing orderId param</h1>');
        }

        // Retrieve donation data from SQLite
        const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
        if (!donation) {
            console.error('[Iframe Redirect] No matching donor data found for order ID:', orderId);
            return res.status(404).send('<h1>Error: no matching donor data</h1>');
        }
        console.log('[Iframe Redirect] Donation data retrieved:', donation);

        // Amount is already in cents
        const amountCents = donation.donation_amount;

        const params = {
            DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
            DS_MERCHANT_TERMINAL: TERMINAL,
            DS_MERCHANT_ORDER: orderId,
            DS_MERCHANT_AMOUNT: amountCents,
            DS_MERCHANT_CURRENCY: '978', // EUR
            DS_MERCHANT_TRANSACTIONTYPE: '0',
            DS_MERCHANT_CONSUMERLANGUAGE: '2',
            DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
            DS_MERCHANT_URLOK: MERCHANT_URLOK,
            DS_MERCHANT_URLKO: MERCHANT_URLKO,
            Ds_Merchant_PersoCode: '1'
        };

        let form;
        try {
            form = createRedirectForm(params);
        } catch (err) {
            console.error('[Iframe Redirect] Error creating redirect form:', err);
            return res.status(500).send('<h1>Error: could not generate payment form</h1>');
        }

        console.log('[Iframe Redirect] Redsys redirect form generated for order ID:', orderId);

        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Payment Redirect</title>
                <style>
body {
    margin: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    background-color: transparent;
}

.spinner {
    border: 12px solid #f3f3f3;
    border-top: 12px solid #4CAF50;
    border-radius: 50%;
    width: 80px;
    height: 80px;
    animation: spin 2s linear infinite;
}
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
@media (min-width: 601px) {
    .spinner {
        width: 120px;
        height: 120px;
        border-width: 16px;
    }
}
                </style>
            </head>
            <body onload="document.forms[0].submit()">
                <div class="spinner"></div>
                <form action="${form.url}" method="POST" style="display:none;">
                    <input type="hidden" name="Ds_SignatureVersion" value="${form.body.Ds_SignatureVersion}" />
                    <input type="hidden" name="Ds_MerchantParameters" value="${form.body.Ds_MerchantParameters}" />
                    <input type="hidden" name="Ds_Signature" value="${form.body.Ds_Signature}" />
                </form>
            </body>
            </html>
        `;
        res.send(html);
    } catch (err) {
        console.error('[Iframe Redirect] Error in /iframe-sis:', err);
        next(err);
    }
});

// Redsys payment notification endpoint
app.post('/redsys-notification', async (req, res, next) => {
    try {
        console.log('[Redsys Notification] Received notification with body:', req.body);
        let result;
        try {
            result = processRedirectNotification(req.body);
        } catch (err) {
            console.error('[Redsys Notification] Error processing notification:', err);
            // Even if there's an error, respond with 'OK' so Redsys doesn't keep retrying indefinitely
            return res.send('OK');
        }
        console.log('[Redsys Notification] Processed result:', result);

        const responseCode = parseInt(result.Ds_Response || '9999', 10);

        if (responseCode < 100) {
            console.log('[Redsys Notification] Payment SUCCESS:', result);
            const orderId = result.Ds_Order;
            const amountCents = parseInt(result.Ds_Amount);

            // Retrieve the donation from the database using the orderId
            const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
            if (!donation) {
                console.warn('[Redsys Notification] Donation not found for order ID:', orderId);
                return res.send('OK');
            }

            // If we already sent the conversion
            if (donation.fb_conversion_sent === 1) {
                console.log('[Redsys Notification] Conversion already sent for donation with order ID:', orderId);
                return res.send('OK');
            }

            // Update donation amount in case it's different
            if (donation.donation_amount !== amountCents) {
                console.log('[Redsys Notification] Updating donation amount for order ID:', orderId);
                await dbRun(
                    'UPDATE donations SET donation_amount = ? WHERE id = ?',
                    [amountCents, donation.id]
                );
                donation.donation_amount = amountCents;
            }

            // Log payload and insert conversion log
            const rawPayload = JSON.stringify(req.body);
            console.log('[Redsys Notification] Logging FB conversion payload:', rawPayload);
            const insertLogResult = await dbRun(
                `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status) VALUES (?, ?, ?, ?)`,
                [donation.id, rawPayload, 0, 'pending']
            );
            const logId = insertLogResult.lastID;
            console.log('[Redsys Notification] FB conversion log inserted with ID:', logId);

            // Attempt FB conversion with retry
            const conversionResult = await attemptFacebookConversion(donation);
            const now = new Date().toISOString();

            if (conversionResult.success) {
                console.log('[Redsys Notification] FB conversion successful for donation id:', donation.id);
                await dbRun(
                    `UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?`,
                    [conversionResult.attempts, now, logId]
                );
                await dbRun(
                    `UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?`,
                    [donation.id]
                );
            } else {
                console.error('[Redsys Notification] FB conversion failed after retries for donation id:', donation.id);
                await dbRun(
                    `UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?`,
                    [
                        conversionResult.attempts,
                        now,
                        conversionResult.error ? conversionResult.error.message : '',
                        logId,
                    ]
                );
            }

            return res.send('OK');
        } else {
            console.warn('[Redsys Notification] Payment Failed or Rejected:', result);
            // Log failed payment
            await dbRun(
                `INSERT INTO payment_failures (order_id, amount, error) VALUES (?, ?, ?)`,
                [result.Ds_Order, result.Ds_Amount, `Response code: ${responseCode}`]
            );
            return res.send('OK');
        }
    } catch (err) {
        console.error('[Redsys Notification] Error in /redsys-notification:', err);
        next(err);
    }
});

// ------------------------------------------------------
// Custom THANKS and ERROR Routes
// ------------------------------------------------------
app.get('/thanks', (req, res) => {
    // A simple "Thank you" page design
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Thank You</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: Arial, sans-serif;
                    background: #f5f5f5;
                }
                .container {
                    text-align: center;
                    padding: 50px;
                }
                h1 {
                    color: #4CAF50;
                }
                p {
                    font-size: 1.2em;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Thank You!</h1>
                <p>Your Payment Was Successful</p>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

app.get('/error', (req, res) => {
    // A simple "Error" page design
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Error</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: Arial, sans-serif;
                    background: #f5f5f5;
                }
                .container {
                    text-align: center;
                    padding: 50px;
                }
                h1 {
                    color: #f44336;
                }
                p {
                    font-size: 1.2em;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Oops! Something went wrong.</h1>
                <p>It seems there was a problem with your payment. Please try again.</p>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// ------------------------------------------------------
// BACKGROUND WORKER: Retry Pending FB Conversions
// ------------------------------------------------------
setInterval(async () => {
    try {
        console.log('[Background Worker] Checking for pending FB conversions...');
        const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent' AND attempts < 3");
        for (const log of logs) {
            const donationRow = await dbGet("SELECT * FROM donations WHERE id = ?", [log.donation_id]);
            if (!donationRow) continue;
            console.log(`[Background Worker] Retrying FB conversion for donation id ${donationRow.id}`);
            console.log('[Background Worker] Donation data:', donationRow);
            const result = await attemptFacebookConversion(donationRow);
            const now = new Date().toISOString();
            if (result.success) {
                console.log(`[Background Worker] FB conversion retried successfully for donation id ${donationRow.id}`);
                await dbRun(
                    `UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?`,
                    [result.attempts, now, log.id]
                );
                await dbRun(
                    `UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?`,
                    [donationRow.id]
                );
            } else {
                console.warn(`[Background Worker] Retry pending for donation id ${donationRow.id}`);
                await dbRun(
                    `UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?`,
                    [
                        result.attempts,
                        now,
                        result.error ? result.error.message : '',
                        log.id
                    ]
                );
            }
        }
    } catch (err) {
        console.error("[Background Worker] Error processing pending FB conversions:", err);
    }
}, 60000); // Run every minute

// ------------------------------------------------------
// ERROR HANDLING MIDDLEWARE
// ------------------------------------------------------
app.use((err, req, res, next) => {
    console.error('[Error Handling] Unhandled error in middleware:', err);
    res.status(500).json({ error: 'An internal server error occurred.' });
});

// ------------------------------------------------------
// GLOBAL PROCESS ERROR HANDLERS
// ------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Global Error] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Global Error] Uncaught Exception:', err);
});

// ------------------------------------------------------
// START THE SERVER
// ------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
