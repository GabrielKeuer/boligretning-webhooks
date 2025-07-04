import crypto from 'crypto';

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
        subject: `VidaXL Ordre Fejl - ${order.name}`,
        html: `
          <h2>Ordre kunne ikke sendes til VidaXL</h2>
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

async function sendToVidaXL(order) {
  console.log('📤 Sender til VidaXL...');
  
  const vidaxlOrder = {
    customer_order_reference: order.name,
    addressbook: {
      country: order.shipping_address.country_code
    },
    order_products: order.line_items.map(item => ({
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
        phone: order.shipping_address.phone || order.phone || '',
        comments: order.note || ''
      }
    }))
  };
  
  const response = await fetch('https://b2b.vidaxl.com/api_customer/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.VIDAXL_EMAIL}:${process.env.VIDAXL_API_TOKEN}`).toString('base64')
    },
    body: JSON.stringify(vidaxlOrder)
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`VidaXL API error: ${JSON.stringify(result)}`);
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
    
    console.log('📦 Ordre detaljer:', {
      name: order.name,
      email: order.email,
      products: order.line_items?.map(item => ({
        sku: item.sku,
        qty: item.quantity,
        name: item.name
      }))
    });
    
    // Send til VidaXL
    try {
      const vidaxlResult = await sendToVidaXL(order);
      console.log('✅ Ordre sendt til VidaXL!', vidaxlResult.order?.id);
      
      // Svar Shopify EFTER VidaXL success
      res.status(200).json({ 
        success: true,
        vidaxl_order_id: vidaxlResult.order?.id
      });
      
    } catch (vidaxlError) {
      console.error('❌ VidaXL fejl:', vidaxlError.message);
      
      // Send error email
      await sendErrorEmail(order, {
        error: vidaxlError.message,
        timestamp: new Date().toISOString()
      });
      
      // Svar success til Shopify alligevel
      res.status(200).json({ 
        success: false,
        error: 'VidaXL API fejlede - email sendt'
      });
    }
    
  } catch (error) {
    console.error('❌ Webhook fejl:', error);
    res.status(500).json({ error: error.message });
  }
}
