// api/vidaxl-retry.js
// Manuel endpoint til at gensende ordre til VidaXL

export default async function handler(req, res) {
  // Check auth
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { orderId, orderNumber } = req.body;
  
  if (!orderId && !orderNumber) {
    return res.status(400).json({ error: 'Order ID or order number required' });
  }
  
  console.log(`🔄 Manual retry for ordre: ${orderId || orderNumber}`);
  
  let order; // Flyttet uden for try block
  
  try {
    // Hvis ordre nummer (f.eks. #362673)
    if (orderNumber) {
      const searchResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderNumber)}&status=any`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const searchData = await searchResponse.json();
      if (!searchData.orders || searchData.orders.length === 0) {
        throw new Error('Ordre ikke fundet');
      }
      
      // Find exact match
      order = searchData.orders.find(o => o.name === orderNumber);
      if (!order) {
        throw new Error(`Ingen exact match for ${orderNumber}`);
      }
    } 
    // Hvis ordre ID
    else {
      const orderResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}.json`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!orderResponse.ok) {
        throw new Error('Ordre ikke fundet med ID');
      }
      
      const data = await orderResponse.json();
      order = data.order;
    }
    
    console.log(`📦 Fandt ordre: ${order.name}`);
    
    // Filtrer kun aktive line items (ikke refunderede/cancelled)
    const activeLineItems = order.line_items.filter(item => {
      // Skip hvis refunderet eller cancelled
      if (item.fulfillable_quantity === 0 && item.quantity > 0) {
        console.log(`⏭️ Springer over refunderet produkt: ${item.sku} - ${item.name}`);
        return false;
      }
      // Skip hvis ingen SKU
      if (!item.sku) {
        console.log(`⏭️ Springer over produkt uden SKU: ${item.name}`);
        return false;
      }
      return true;
    });
    
    if (activeLineItems.length === 0) {
      throw new Error('Ingen aktive produkter at sende til VidaXL');
    }
    
    console.log(`📦 Sender ${activeLineItems.length} aktive produkter (ud af ${order.line_items.length} total)`);
    
    // Send til VidaXL (samme logik som webhook)
    const vidaxlOrder = {
      customer_order_reference: order.name,
      addressbook: {
        country: order.shipping_address.country_code
      },
      order_products: activeLineItems.map(item => ({
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
    
    const vidaxlResponse = await fetch('https://b2b.vidaxl.com/api_customer/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${process.env.VIDAXL_EMAIL}:${process.env.VIDAXL_API_TOKEN}`).toString('base64')
      },
      body: JSON.stringify(vidaxlOrder)
    });
    
    const result = await vidaxlResponse.json();
    
    if (!vidaxlResponse.ok) {
      throw new Error(`VidaXL API error: ${JSON.stringify(result)}`);
    }
    
    // Success!
    console.log(`✅ Ordre sendt til VidaXL! ID: ${result.order?.id}`);
    
    return res.json({
      success: true,
      shopify_order: order.name,
      vidaxl_order_id: result.order?.id,
      products_sent: activeLineItems.length,
      products_skipped: order.line_items.length - activeLineItems.length
    });
    
  } catch (error) {
    console.error('❌ Retry fejl:', error);
    
    // Send fejl email hvis vi har ordre info
    if (typeof order !== 'undefined' && order) {
      await sendErrorEmail(order, {
        error: error.message,
        timestamp: new Date().toISOString(),
        retry_attempt: true
      });
    }
    
    // Special handling for product not active
    if (error.message && error.message.includes('Product is not active')) {
      return res.status(400).json({
        success: false,
        error: 'Et eller flere produkter er ikke aktive hos VidaXL',
        details: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Genbrugt email funktion
async function sendErrorEmail(order, error) {
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
        subject: `VidaXL Retry Fejl - ${order.name}`,
        html: `
          <h2>Manuel retry fejlede</h2>
          <p><strong>Ordre:</strong> ${order.name}</p>
          <p><strong>Kunde:</strong> ${order.email}</p>
          <p><strong>Fejl:</strong></p>
          <pre style="background: #f5f5f5; padding: 10px;">${JSON.stringify(error, null, 2)}</pre>
          <p><a href="https://admin.shopify.com/store/boligretning/orders/${order.id}">Se ordre i Shopify</a></p>
        `
      })
    });
  } catch (e) {
    console.error('Email error:', e);
  }
}
