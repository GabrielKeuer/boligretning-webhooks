export default async function handler(req, res) {
  // Log webhook modtaget
  console.log('🚀 Shopify webhook modtaget!', new Date().toISOString())
  console.log('Headers:', req.headers)
  
  // Kun POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  
  try {
    const order = req.body
    
    console.log('📦 Ordre info:', {
      orderName: order.name,
      orderID: order.id,
      customer: order.email,
      totalPrice: order.total_price,
      lineItems: order.line_items?.length || 0
    })
    
    // Log produkter
    order.line_items?.forEach(item => {
      console.log(`- ${item.quantity}x ${item.sku} - ${item.name}`)
    })
    
    // TODO: Send til VidaXL API
    // TODO: Send fejl email hvis det fejler
    
    res.status(200).json({ 
      success: true,
      message: 'Webhook modtaget',
      orderId: order.name
    })
    
  } catch (error) {
    console.error('❌ Fejl:', error)
    res.status(500).json({ 
      error: 'Webhook fejlede',
      details: error.message 
    })
  }
}
