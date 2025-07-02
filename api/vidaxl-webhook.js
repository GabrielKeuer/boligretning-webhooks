import crypto from 'crypto';

// Verify Shopify webhook
function verifyWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === signature;
}

export default async function handler(req, res) {
  console.log('🚀 Webhook modtaget!', new Date().toISOString());
  
  // Kun POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Verificer webhook signature
  const signature = req.headers['x-shopify-hmac-sha256'];
  
  // VIGTIGT: Vi skal bruge raw body til HMAC
  const rawBody = JSON.stringify(req.body);
  
  if (!signature || !verifyWebhook(rawBody, signature)) {
    console.error('❌ Invalid webhook signature!');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('✅ Webhook verificeret!');
  
  try {
    const order = req.body;
    
    console.log('📦 Ordre:', {
      name: order.name,
      email: order.email,
      products: order.line_items?.length
    });
    
    // TODO: Send til VidaXL
    
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('❌ Fejl:', error);
    res.status(500).json({ error: error.message });
  }
}

// Vigtig config for at få raw body
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};
