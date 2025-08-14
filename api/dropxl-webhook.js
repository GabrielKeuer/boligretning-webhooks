import crypto from 'crypto';

// Tilladt vendor liste - DropXL håndterer disse brands
// Inkluderer både 'vidaXL' (som det står i Shopify) og case variations
const DROPXL_VENDORS = ['vidaXL', 'VidaXL', 'vidaxl', 'Bestway', 'bestway', 'Keter', 'keter'];

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifyWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET2)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

async function sendErrorEmail(order, error) {
  console.log('📧 Sender fejl email...');
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'BoligRetning <onboarding@resend.dev>',
        to: 'kontakt@boligretning.dk',
        subject: `DropXL Ordre Fejl - ${order.name}`,
        html: `
          <h2>Ordre kunne ikke sendes til DropXL</h2>
          <p><strong>Ordre:</strong> ${order.name}</p>
          <p><strong>Kunde:</strong> ${order.email}</p>
          <p><strong>Fejl:</strong></p>
          <pre style="background: #f5f5f5; padding: 10px;">${JSON.stringify(error, null, 2)}</pre>
          <p><a href="https://admin.shopify.com/store/boligretning/orders/${order.id}">Se ordre i Shopify</a></p>
        `
      })
    });
    
    if (!response.ok) {
      console.error('Email fejlede:', await response.text());
    } else {
      console.log('✅ Fejl email sendt');
    }
  } catch (e) {
    console.error('Email error:', e);
  }
}

async function sendToDropXL(order, dropxlItems) {  // Nu tager den filtrerede items som parameter
  console.log('📤 Sender til DropXL...');
  
  // Fallback telefonnummer - DropXL kræver altid telefon
  const fallbackPhone = order.shipping_address.phone || order.phone || process.env.COMPANY_PHONE || '70701870';
  
  const dropxlOrder = {
    customer_order_reference: order.name,
    addressbook: {
      country: order.shipping_address.country_code
    },
    order_products: dropxlItems.map(item => ({  // Bruger filtrerede items
      product_code: item.sku,
      quantity: item.quantity,
      addressbook: {
        name: order.shipping_address.name,
        address: order.shipping_address.address1,
        address2: order.shipping_address.address2 || '',
        city: order.shipping_address.city,
        province: order.shipping_address.province || '',
        postal_code: order.shipping_address.zip,
        country: order.shipping_address.country_code,
        email: order.email,
        phone: fallbackPhone,
        comments: order.note || ''
      }
    }))
  };
  
  // Ny DropXL endpoint og authentication
  const response = await fetch('https://b2b.dropxl.com/api_customer/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.DROPXL_EMAIL}:${process.env.DROPXL_API_TOKEN}`).toString('base64')
    },
    body: JSON.stringify(dropxlOrder)
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`DropXL API error: ${JSON.stringify(result)}`);
  }
  
  return result;
}

export default async function handler(req, res) {
  console.log('🚀 Webhook modtaget!');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-shopify-hmac-sha256'];
    
    if (!signature || !verifyWebhook(rawBody, signature)) {
      console.error('❌ Invalid webhook signature!');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('✅ Webhook verificeret!');
    
    const order = JSON.parse(rawBody.toString());

    // Check webhook type
    const topic = req.headers['x-shopify-topic'];
    console.log('📌 Webhook type:', topic);
    
    // Hvis det er en ordre opdatering
    if (topic === 'orders/updated') {
      // Check om der er retry kommando i noten
      const hasRetryNote = order.note && order.note.includes('RETRY');
      
      if (!hasRetryNote) {
        console.log('⏭️ Ordre opdatering uden retry kommando - ignorerer');
        res.status(200).json({ message: 'Skipped - no retry command' });
        return;
      }
      
      console.log('🔄 RETRY fundet i note - sender til DropXL!');
    }
    
    // VENDOR FILTERING: Filtrer kun DropXL produkter
    const dropxlItems = order.line_items.filter(item => {
      // Skip hvis ingen vendor
      if (!item.vendor) {
        console.log(`⏭️ Springer over produkt uden vendor: ${item.sku} - ${item.name}`);
        return false;
      }
      
      // Check om vendor er i DropXL listen
      if (!DROPXL_VENDORS.includes(item.vendor)) {
        console.log(`⏭️ Springer over non-DropXL produkt: ${item.sku} - ${item.name} (Vendor: ${item.vendor})`);
        return false;
      }
      
      // Skip hvis ingen SKU
      if (!item.sku) {
        console.log(`⏭️ Springer over DropXL produkt uden SKU: ${item.name}`);
        return false;
      }
      
      return true;
    });
    
    // Hvis ingen DropXL produkter, skip helt - DETTE ER IKKE EN FEJL!
    if (dropxlItems.length === 0) {
      console.log(`📝 Ingen DropXL produkter i ordre ${order.name} - det er helt OK!`);
      console.log(`   Ordre indeholder kun produkter fra andre leverandører`);
      return res.status(200).json({ 
        success: true,
        message: 'No DropXL products in order - other vendors only',
        products_total: order.line_items.length,
        products_dropxl: 0,
        skipped_reason: 'non_dropxl_vendors'
      });
    }
    
    console.log(`📦 Ordre detaljer:`, {
      name: order.name,
      email: order.email,
      total_products: order.line_items.length,
      dropxl_products: dropxlItems.length,
      skipped_products: order.line_items.length - dropxlItems.length,
      vendors_included: [...new Set(dropxlItems.map(item => item.vendor))],
      products: dropxlItems.map(item => ({
        sku: item.sku,
        qty: item.quantity,
        name: item.name,
        vendor: item.vendor
      }))
    });
    
    // Send til DropXL (kun DropXL produkter)
    try {
      const dropxlResult = await sendToDropXL(order, dropxlItems);  // Send filtrerede items
      console.log(`✅ Ordre sendt til DropXL! ID: ${dropxlResult.order?.id}`);
      console.log(`📊 ${dropxlItems.length} DropXL produkter sendt, ${order.line_items.length - dropxlItems.length} andre produkter ignoreret`);
      
      // Svar Shopify EFTER DropXL success
      res.status(200).json({ 
        success: true,
        dropxl_order_id: dropxlResult.order?.id,
        products_sent: dropxlItems.length,
        products_skipped: order.line_items.length - dropxlItems.length,
        vendors_included: [...new Set(dropxlItems.map(item => item.vendor))]
      });
      
    } catch (dropxlError) {
      console.error('❌ DropXL fejl:', dropxlError.message);
      
      // Send error email
      await sendErrorEmail(order, {
        error: dropxlError.message,
        timestamp: new Date().toISOString(),
        products_attempted: dropxlItems.length,
        products_skipped: order.line_items.length - dropxlItems.length
      });
      
      // Svar success til Shopify alligevel
      res.status(200).json({ 
        success: false,
        error: 'DropXL API fejlede - email sendt'
      });
    }
    
  } catch (error) {
    console.error('❌ Webhook fejl:', error);
    res.status(500).json({ error: error.message });
  }
}
