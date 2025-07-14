const express = require('express');
const fetch = require('node-fetch'); // Still needed for WooCommerce API calls
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const app = express();

// --- ULTIMATE CORS SETUP ---
// This middleware will run for every incoming request
app.use((req, res, next) => {
    // Get the actual origin from the request headers
    const origin = req.headers.origin;

    // Define the ONLY allowed frontend origin
    const allowedFrontendOrigin = 'https://five4autoworks-frontend.onrender.com'; 

    // If the request origin matches our allowed frontend, set the header explicitly
    if (origin === allowedFrontendOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true'); // Required for session/cookies
    } else {
        // For any other unexpected origin, you might choose to block or log
        // For now, we'll just not set the ACAO header, which will cause a CORS error for disallowed origins.
        // console.warn(`[CORS] Request from disallowed origin: ${origin}`);
    }

    // Always allow these methods and headers for preflight and actual requests
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cart-Token, woocommerce-session'); // Expose custom headers

    // Handle preflight requests (OPTIONS method)
    if (req.method === 'OPTIONS') {
        // For OPTIONS requests, immediately send 200 OK with the headers set above
        return res.sendStatus(200);
    }

    next(); // Continue to the next middleware/route
});

app.use(express.json()); // For parsing application/json

const WOO_API_URL = process.env.WOO_API_URL; 
const WOO_CONSUMER_KEY = process.env.WOO_CONSUMER_KEY;
const WOO_CONSUMER_SECRET = process.env.WOO_CONSUMER_SECRET;
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY; 

// Store the nonce globally on the server-side
let wooApiNonce = null;

// Basic authentication header for WooCommerce (used for /init and possibly /products depending on setup)
let wooAuth = null;
if (WOO_CONSUMER_KEY && WOO_CONSUMER_SECRET) {
    wooAuth = Buffer.from(`${WOO_CONSUMER_KEY}:${WOO_CONSUMER_SECRET}`).toString('base64');
} else {
    console.error('[FATAL] WooCommerce Consumer Key or Secret is missing in .env. API calls requiring Basic Auth will fail. Cart calls *should* still work if WOO_API_URL is correct for Store API.');
}

// --- Exchange Rate Logic (Still uses hardcoded defaults for now) ---
let cachedExchangeRates = { USD: 1, ZAR: 19.00 }; // Always use default rates
let lastFetchTime = Date.now(); // Set initial fetch time to avoid immediate re-fetch logic

async function fetchExchangeRates() {
    console.log('[PROXY] Exchange rates are hardcoded. No external API call made.');
    return cachedExchangeRates;
}

// Define a unique User-Agent string for your proxy
const USER_AGENT_STRING = '54Autoworks-NodeJS-Proxy/1.0';

// --- API ROUTES ---

// Endpoint for initial session setup (fetches current cart and passes back session token)
app.get('/api/init', async (req, res) => {
    console.log('[PROXY] Calling /api/init to get initial cart state...');
    
    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT_STRING
    };

    const clientCartToken = req.headers['cart-token'];
    if (clientCartToken) {
        headers['Cart-Token'] = clientCartToken; 
        console.log('[PROXY] /init: Forwarding existing Cart-Token from client:', clientCartToken);
    } else {
        console.log('[PROXY] /init: No existing cart token from client. Initiating new session.');
    }

    try {
        const targetUrl = `${WOO_API_URL}/cart`;
        console.log(`[PROXY] /init: Attempting to fetch from: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] /init: Sending headers to WooCommerce:', headers); // Log headers
        const response = await fetch(targetUrl, {
            headers: headers
        });

        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken); // Set custom header for frontend
            console.log('[PROXY] /init: New/Updated WooCommerce Session Token received and set in response header:', newWooSessionToken);
        } else {
            console.warn('[PROXY] /init: No new woocommerce-session header received in cart response.');
        }

        const nonceFromHeader = response.headers.get('nonce'); 
        if (nonceFromHeader) {
            wooApiNonce = nonceFromHeader;
            console.log('[PROXY] /init: Captured Nonce from response header:', wooApiNonce);
        } else {
            console.warn('[PROXY] /init: No Nonce header found in /cart response.');
        }

        const data = await response.json();
        if (!response.ok) {
            console.error('[PROXY] /init: WooCommerce API error on cart fetch:', data);
            return res.status(response.status).json({ message: data.message || 'Failed to initialize session from WooCommerce', details: data });
        }
        
        res.json({ cart: data, cartToken: newWooSessionToken || clientCartToken });

    } catch (error) {
        console.error('[PROXY] Error in /api/init:', error.message);
        res.status(500).json({ message: 'Failed to initialize session.', details: error.message });
    }
});


app.get('/api/exchange-rates', async (req, res) => {
    const rates = await fetchExchangeRates();
    res.json(rates);
});

app.get('/api/products', async (req, res) => {
    console.log('[PROXY] Calling /api/products...');
    try {
        const targetUrl = `${WOO_API_URL}/products?per_page=100`;
        console.log(`[PROXY] /products: Attempting to fetch from: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] /products: Sending headers:', { 'User-Agent': USER_AGENT_STRING }); // Log headers
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': USER_AGENT_STRING }
        }); 
        const data = await response.json();
        if (!response.ok) {
            console.error('[PROXY] WooCommerce API error on products fetch:', data);
            throw new Error(data.message || 'Failed to fetch products');
        }
        res.json(data);
    } catch (error) {
        console.error('[PROXY] Error in /api/products:', error.message);
        res.status(500).json({ message: 'Failed to fetch products.', details: error.message });
    }
});

// Cart Add Item
app.post('/api/cart/add', async (req, res) => {
    const { productId, quantity } = req.body;
    const clientCartToken = req.headers['cart-token']; // Get token from frontend

    console.log(`[PROXY] Add to cart request: Product ID ${productId}, Quantity ${quantity}, Client Cart Token: ${clientCartToken}`);

    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT_STRING
    };

    if (clientCartToken) {
        headers['Cart-Token'] = clientCartToken; 
        console.log('[PROXY] Add: Sending Cart-Token header to WooCommerce:', clientCartToken);
    } else {
        console.log('[PROXY] Add: No existing cart token provided by client, starting new session.');
    }

    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; 
        console.log('[PROXY] Add: Sending Nonce header to WooCommerce:', wooApiNonce);
    } else {
        console.warn('[PROXY] Add: No Nonce available to send for add to cart.');
    }

    try {
        const targetUrl = `${WOO_API_URL}/cart/add-item`;
        console.log(`[PROXY] Add: Attempting to POST to: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] Add: Sending headers to WooCommerce:', headers); // Log headers
        console.log('[PROXY] Add: Sending body:', JSON.stringify({ id: productId, quantity: quantity })); // Log body
        const response = await fetch(targetUrl, { 
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                id: productId,
                quantity: quantity
            })
        });

        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken); // Set custom header for frontend
            console.log('[PROXY] Add: New/Updated WooCommerce Session Token received and set:', newWooSessionToken);
        } else {
            console.warn('[PROXY] Add: No new woocommerce-session header received in add to cart response.');
        }

        const data = await response.json();
        if (!response.ok) {
            console.error('[PROXY] Add: WooCommerce API error on add to cart:', data);
            return res.status(response.status).json({ message: data.message || 'Failed to add to cart', details: data });
        }
        res.status(response.status).json(data); // Send back the updated cart object
    } catch (error) {
        console.error('[PROXY] Error adding to cart:', error);
        res.status(500).json({ error: 'Failed to add item to cart.', details: error.message });
    }
});

// Cart Update Item
app.post('/api/cart/update-item', async (req, res) => {
    const { key, quantity } = req.body;
    const clientCartToken = req.headers['cart-token'];

    console.log(`[PROXY] Update item request: Item Key ${key}, Quantity ${quantity}, Client Cart Token: ${clientCartToken}`);

    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT_STRING
    };

    if (clientCartToken) {
        headers['Cart-Token'] = clientCartToken; 
        console.log('[PROXY] Update: Sending Cart-Token header to WooCommerce:', clientCartToken);
    }

    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; 
        console.log('[PROXY] Update: Sending Nonce header to WooCommerce:', wooApiNonce);
    } else {
        console.warn('[PROXY] Update: No Nonce available to send for update cart.');
    }

    try {
        const targetUrl = `${WOO_API_URL}/cart/update-item`;
        console.log(`[PROXY] Update: Attempting to POST to: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] Update: Sending headers to WooCommerce:', headers); // Log headers
        console.log('[PROXY] Update: Sending body:', JSON.stringify({ key: key, quantity: quantity })); // Log body
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                key: key,
                quantity: quantity 
            })
        });

        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('[PROXY] Update: New/Updated WooCommerce Session Token received and set:', newWooSessionToken);
        }

        const data = await response.json();
        if (!response.ok) {
            console.error('[PROXY] Update: WooCommerce API error on update item:', data);
            return res.status(response.status).json({ message: data.message || 'Failed to update item quantity', details: data });
        }
        res.status(response.status).json(data);
    } catch (error) {
        console.error('[PROXY] Error updating item quantity:', error);
        res.status(500).json({ error: 'Failed to update item quantity in cart.' });
    }
});

// Cart Remove Item
app.post('/api/cart/remove-item', async (req, res) => {
    const { key } = req.body;
    const clientCartToken = req.headers['cart-token'];

    console.log(`[PROXY] Remove item request: Item Key ${key}, Client Cart Token: ${clientCartToken}`);

    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT_STRING
    };

    if (clientCartToken) {
        headers['Cart-Token'] = clientCartToken; 
        console.log('[PROXY] Remove: Sending Cart-Token header to WooCommerce:', clientCartToken);
    }

    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; 
        console.log('[PROXY] Remove: Sending Nonce header to WooCommerce:', wooApiNonce);
    } else {
        console.warn('[PROXY] Remove: No Nonce available to send for remove cart.');
    }

    try {
        const targetUrl = `${WOO_API_URL}/cart/remove-item`;
        console.log(`[PROXY] Remove: Attempting to POST to: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] Remove: Sending headers to WooCommerce:', headers); // Log headers
        console.log('[PROXY] Remove: Sending body:', JSON.stringify({ key: key })); // Log body
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                key: key
            })
        });

        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('[PROXY] Remove: New/Updated WooCommerce Session Token received and set:', newWooSessionToken);
        }

        if (response.status === 204) {
            return res.status(204).send();
        }

        let data = {};
        if (response.status !== 204) {
            try {
                data = await response.json();
                console.log('removeItem: Successful response data (if any):', data);
            } catch (jsonError) {
                console.warn('removeItem: Could not parse JSON from non-204 remove response:', jsonError);
                if (!response.ok) {
                    throw new Error(`Store API remove failed with status ${response.status}`);
                }
            }
        } else {
            console.log('removeItem: Successful (204 No Content).');
        }

        res.status(response.status).json(data); // Send back response from WooCommerce
    } catch (error) {
        console.error('removeItem: Catch block - Remove item error:', error);
        res.status(500).json({ error: 'Failed to remove item.', details: error.message });
    }
    console.log(`removeItem finished for item ${key}`); 
});


// Get Cart (for /api/init and also for cart.html directly)
app.get('/api/cart', async (req, res) => {
    console.log('[PROXY] Calling /api/cart to get current cart state...');
    
    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT_STRING
    };

    const clientCartToken = req.headers['cart-token'];
    if (clientCartToken) {
        headers['Cart-Token'] = clientCartToken; 
        console.log('[PROXY] /cart (GET): Forwarding existing Cart-Token from client:', clientCartToken);
    } else {
        console.log('[PROXY] /cart (GET): No existing cart token from client.');
    }

    try {
        const targetUrl = `${WOO_API_URL}/cart`;
        console.log(`[PROXY] /cart (GET): Attempting to fetch from: ${targetUrl}`); // Debugging URL
        console.log('[PROXY] /cart (GET): Sending headers to WooCommerce:', headers); // Log headers
        const response = await fetch(targetUrl, {
            headers: headers
        });

        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('[PROXY] /cart (GET): New/Updated WooCommerce Session Token received and set:', newWooSessionToken);
        }

        const data = await response.json();
        if (!response.ok) {
            console.error('[PROXY] /cart (GET): WooCommerce API error on cart fetch:', data);
            return res.status(response.status).json({ message: data.message || 'Failed to fetch cart', details: data });
        }
        res.json({ cart: data, cartToken: newWooSessionToken || clientCartToken }); // Send both cart data and token
    } catch (error) {
        console.error('[PROXY] Error in /api/cart (GET):', error.message);
        res.status(500).json({ message: 'Failed to fetch cart.', details: error.message });
    }
});

// Vercel requires exporting the app for serverless functions
module.exports = app;
