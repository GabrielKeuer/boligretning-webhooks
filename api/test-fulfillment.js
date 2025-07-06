export default async function handler(req, res) {
  // Test endpoint - kun med CRON_SECRET
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const orderNumber = req.body.order_number || "#362628";
  const trackingNumber = req.body.tracking || "YNZX9BHU";
  const trackingUrl = req.body.url || "https://gls-group.eu/EU/en/parcel-tracking?match=YNZX9BHU";
  const carrier = req.body.carrier || "GLS";
  
  console.log('🧪 TEST FULFILLMENT for ordre:', orderNumber);
  
  try {
    // Find ordre i Shopify
    const order = await findShopifyOrder(orderNumber);
    
    if (!order) {
      return res.status(404).json({
        error: 'Ordre ikke fundet',
        order_number: orderNumber
      });
    }
    
    console.log('✅ Ordre fundet:', {
      name: order.name,
      id: order.id,
      status: order.fulfillment_status,
      customer: order.email
    });
    
    // Check om allerede fulfilled
    if (order.fulfillment_status === 'fulfilled') {
      return res.json({ 
        message: 'Ordre allerede fulfilled',
        order_name: order.name,
        status: 'skipped'
      });
    }
    
    // Opret fulfillment præcis som i sync
    const fulfillmentData = {
      fulfillment: {
        location_id: "pending",
        tracking_number: trackingNumber,
        tracking_urls: [trackingUrl],
        tracking_company: detectCarrier(trackingUrl),
        notify_customer: true, // Sender tracking email!
        line_items: [] // Tom = fulfill alle items
      }
    };
    
    console.log('📦 Opretter fulfillment med:', {
      tracking: trackingNumber,
      carrier: detectCarrier(trackingUrl),
      url: trackingUrl
    });
    
    const fulfillmentResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${order.id}/fulfillments.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fulfillmentData)
      }
    );
    
    if (!fulfillmentResponse.ok) {
      const error = await fulfillmentResponse.json();
      throw new Error(JSON.stringify(error.errors || error));
    }
    
    const result = await fulfillmentResponse.json();
    
    console.log('✅ SUCCESS! Fulfillment oprettet:', result.fulfillment.id);
    
    return res.json({
      success: true,
      message: 'Fulfillment oprettet og tracking email sendt!',
      order: {
        name: order.name,
        id: order.id,
        customer: order.email
      },
      fulfillment: {
        id: result.fulfillment.id,
        tracking_number: trackingNumber,
        tracking_company: detectCarrier(trackingUrl),
        email_sent: true
      }
    });
    
  } catch (error) {
    console.error('❌ Fejl:', error.message);
    return res.status(500).json({ 
      error: error.message,
      order_number: orderNumber
    });
  }
}

async function findShopifyOrder(orderReference) {
  try {
    // Check om det er et ordre nummer (starter med #36)
    if (orderReference.startsWith('#36') || orderReference.startsWith('36')) {
      const orderName = orderReference.startsWith('#') ? orderReference : `#${orderReference}`;
      console.log(`🔍 Søger efter ordre nummer: ${orderName}`);
      
      const searchResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=${orderName}&status=any`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const searchData = await searchResponse.json();
      if (searchData.orders?.[0]) {
        console.log(`✅ Fandt ordre via nummer: ${orderName}`);
        return searchData.orders[0];
      }
    } else {
      // Det er et ordre ID - hent direkte
      console.log(`🔍 Henter ordre via ID: ${orderReference}`);
      
      const response = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderReference}.json`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Fandt ordre via ID: ${orderReference}`);
        return data.order;
      }
    }
    
    console.log(`❌ Ordre ikke fundet: ${orderReference}`);
    return null;
    
  } catch (error) {
    console.error('Shopify søgefejl:', error);
    return null;
  }
}

function detectCarrier(trackingUrl) {
  if (!trackingUrl) return 'Other';
  const url = trackingUrl.toLowerCase();
  if (url.includes('postnord')) return 'PostNord';
  if (url.includes('gls')) return 'GLS';
  if (url.includes('dao')) return 'DAO';
  if (url.includes('ups')) return 'UPS';
  if (url.includes('dhl')) return 'DHL';
  if (url.includes('dpd')) return 'DPD';
  if (url.includes('bring')) return 'Bring';
  return 'Other';
}
