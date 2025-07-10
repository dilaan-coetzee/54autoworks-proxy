const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // Make sure you have this installed: npm install node-fetch@2

// Load environment variables from .env file
dotenv.config();

// --- .env Variable Check (server.js startup) ---
console.log('--- .env Variable Check (server.js startup) ---');
console.log('process.env.WOO_API_URL:', process.env.WOO_API_URL);
console.log('process.env.WOO_CONSUMER_KEY:', process.env.WOO_CONSUMER_KEY ? 'Loaded' : 'UNDEFINED');
console.log('process.env.WOO_CONSUMER_SECRET:', process.env.WOO_CONSUMER_SECRET ? 'Loaded' : 'UNDEFINED');
console.log('process.env.EXCHANGE_RATE_API_KEY:', process.env.EXCHANGE_RATE_API_KEY ? 'Loaded' : 'UNDEFINED');
console.log('------------------------------------------------');

const app = express();
const port = process.env.PORT || 50000;

app.use(cors({
    origin: 'http://localhost:8080', // Allow requests from your local http-server
    credentials: true,
    exposedHeaders: ['Cart-Token', 'woocommerce-session']
}));
app.use(express.json()); // For parsing application/json

const WOO_API_URL = process.env.WOO_API_URL; // e.g., 'https://yourwordpresssite.com/wp-json/wc/store/v1'
const WOO_CONSUMER_KEY = process.env.WOO_CONSUMER_KEY;
const WOO_CONSUMER_SECRET = process.env.WOO_CONSUMER_SECRET;
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY; // This will now be your ExchangeRate-API key

// Store the nonce globally on the server-side
let wooApiNonce = null;

// Basic authentication header for WooCommerce (used for /init and possibly /products depending on setup)
let wooAuth = null;
if (WOO_CONSUMER_KEY && WOO_CONSUMER_SECRET) {
    wooAuth = Buffer.from(`${WOO_CONSUMER_KEY}:${WOO_CONSUMER_SECRET}`).toString('base64');
} else {
    console.error('[FATAL] WooCommerce Consumer Key or Secret is missing in .env. API calls requiring Basic Auth will fail. Cart calls *should* still work if WOO_API_URL is correct for Store API.');
}

// --- Exchange Rate API Caching ---
let cachedExchangeRates = null;
let lastFetchTime = 0;
const CACHE_DURATION = 3600 * 1000; // Cache for 1 hour (in milliseconds)

async function fetchExchangeRates() {
    if (Date.now() - lastFetchTime < CACHE_DURATION && cachedExchangeRates) {
        console.log('[PROXY] Using cached exchange rates.');
        return cachedExchangeRates;
    }

    if (!EXCHANGE_RATE_API_KEY) {
        console.error('[PROXY] EXCHANGE_RATE_API_KEY is not defined in .env! Cannot fetch dynamic rates.');
        return { USD: 1, ZAR: 19.00 }; // Fallback to hardcoded rates
    }

    // --- NEW ExchangeRate-API URL and logic ---
    // We'll fetch base USD and then get ZAR relative to USD
    const BASE_CURRENCY = 'USD'; // ExchangeRate-API typically works with a base currency
    const API_URL = `https://v6.exchangerate-api.com/v6/${EXCHANGE_RATE_API_KEY}/latest/${BASE_CURRENCY}`;
    console.log(`[PROXY] ExchangeRate-API URL being called: ${API_URL}`);

    try {
        console.log(`[PROXY] Fetching exchange rates from ExchangeRate-API: ${API_URL}`);
        const response = await fetch(API_URL);
        const data = await response.json();

        if (response.ok && data.result === 'success' && data.conversion_rates) {
            console.log('[PROXY] Successfully fetched exchange rates from ExchangeRate-API.');
            cachedExchangeRates = {
                USD: data.conversion_rates.USD, // Should be 1 if base is USD
                ZAR: data.conversion_rates.ZAR
            };
            lastFetchTime = Date.now();
            return cachedExchangeRates;
        } else {
            console.error('[PROXY] Failed to fetch exchange rates from ExchangeRate-API:', data.result || data.error_type || 'Unknown error');
            return { USD: 1, ZAR: 19.00 }; // Fallback
        }
    } catch (error) {
        console.error('[PROXY] Error fetching exchange rates from ExchangeRate-API:', error);
        return { USD: 1, ZAR: 19.00 }; // Fallback
    }
}

// Serve static files from the directory where server.js is located
app.use(express.static(__dirname));

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
        // CRITICAL CHANGE: Send as 'Cart-Token' to WooCommerce for GET /cart (init)
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

        // WooCommerce returns the session token in 'woocommerce-session' header
        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken); // Set custom header for frontend
            console.log('[PROXY] /init: New/Updated WooCommerce Session Token received and set in response header:', newWooSessionToken);
        } else {
            console.warn('[PROXY] /init: No new woocommerce-session header received in cart response.');
        }

        // IMPORTANT: Capture the Nonce from the response headers if available
        const nonceFromHeader = response.headers.get('nonce'); // Or 'X-WP-Nonce' depending on WC version/config
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

    // IMPORTANT: Add the Nonce header if we have it
    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; // Or 'X-WP-Nonce' depending on what WC expects
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

        // WooCommerce returns the session token in 'woocommerce-session' header
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

    // IMPORTANT: Add the Nonce header if we have it
    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; // Or 'X-WP-Nonce' depending on what WC expects
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

        // WooCommerce returns the session token in 'woocommerce-session' header
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

    // IMPORTANT: Add the Nonce header if we have it
    if (wooApiNonce) {
        headers['Nonce'] = wooApiNonce; // Or 'X-WP-Nonce' depending on what WC expects
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

        // WooCommerce returns the session token in 'woocommerce-session' header
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

        // Update cart token from response body if available
        if (data.cartToken && data.cartToken !== wooCartToken) {
            wooCartToken = data.cartToken;
            localStorage.setItem('wooCartToken', wooCartToken);
            console.log('removeItem: Updated Cart Token from remove item response body:', wooCartToken);
        } else {
            console.warn("removeItem: No new Cart-Token received in remove item response body or headers.");
        }

        console.log('removeItem: Calling fetchAndDisplayCart after successful removal.');
        await fetchAndDisplayCart();
        console.log('removeItem: fetchAndDisplayCart called after successful item removal.');

    } catch (error) {
        console.error('removeItem: Catch block - Remove item error:', error);
        showCartError(`Failed to remove item: ${error.message}`);
        await fetchAndDisplayCart();
    }
    console.log(`removeItem finished for item ${itemKey}`);
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
        // CRITICAL CHANGE: Send as 'Cart-Token' to WooCommerce for GET /cart
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

        // WooCommerce returns the session token in 'woocommerce-session' header
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


// Start the server
app.listen(port, () => {
    console.log(`Proxy server listening at http://localhost:${port}`);
    console.log('WooCommerce API URL (from server startup):', WOO_API_URL); // CRITICAL: This will show what's loaded
    fetchExchangeRates().then(rates => console.log('[PROXY] Initial exchange rates fetched on startup:', rates));
});
