// api/public-retry.js
// Public endpoint til DropXL retry - token er gemt i miljøvariabel

export default async function handler(req, res) {
  // CORS headers for at tillade browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Kun POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { orderNumber, pin } = req.body;
  
  // Optional: Tilføj simpel PIN kode for ekstra sikkerhed
  if (process.env.PUBLIC_PIN && pin !== process.env.PUBLIC_PIN) {
    return res.status(401).json({ error: 'Ugyldig PIN kode' });
  }
  
  if (!orderNumber) {
    return res.status(400).json({ error: 'Ordre nummer påkrævet' });
  }
  
  try {
    // Log for debugging
    console.log('Attempting retry for order:', orderNumber);
    console.log('CRON_SECRET exists:', !!process.env.CRON_SECRET);
    
    // Kald den eksisterende endpoint med den rigtige token fra miljøvariabel
    const internalUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}/api/dropxl-retry`
      : 'https://boligretning-webhooks.vercel.app/api/dropxl-retry';
    
    console.log('Calling URL:', internalUrl);
    
    const response = await fetch(internalUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ orderNumber })
    });
    
    const data = await response.json();
    
    // Return resultatet
    return res.status(response.status).json(data);
    
  } catch (error) {
    console.error('Public retry error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Kunne ikke gensende ordre' 
    });
  }
}
