import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false, // VIGTIGT: Disable bodyParser!
  },
};

// Få raw body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verify webhook
function verifyWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

export default async function handler(req, res) {
  console.log('🚀 Webhook modtaget!');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Få raw body til HMAC
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-shopify-hmac-sha256'];
    
    console.log('Signature present:', !!signature);
    
    // Verify webhook
    if (!signature || !verifyWebhook(rawBody, signature)) {
      console.error('❌ Invalid webhook signature!');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('✅ Webhook verificeret!');
    
    // Parse body efter verification
    const order = JSON.parse(rawBody.toString());
    
    console.log('📦 Ordre:', {
      name: order.name,
      email: order.email,
      products: order.line_items?.length
    });
    
    // TODO: Send til VidaXL her
    
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('❌ Fejl:', error);
    res.status(500).json({ error: error.message });
  }
}
