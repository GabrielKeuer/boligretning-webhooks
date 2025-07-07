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
    
    // STEP 1: Hent fulfillment orders
    console.log('📋 Henter fulfillment orders for ordre ID:', order.id);
    
    const fulfillmentOrdersUrl = `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`;
    
    const fulfillmentOrdersResponse = await fetch(fulfillmentOrdersUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Response status:', fulfillmentOrdersResponse.status);
    
    const responseText = await fulfillmentOrdersResponse.text();
    
    if (!fulfillmentOrdersResponse.ok) {
      throw new Error(`Fulfillment orders error ${fulfillmentOrdersResponse.status}: ${responseText}`);
    }
    
    const fulfillmentOrdersData = JSON.parse(responseText);
    const fulfillment_orders = fulfillmentOrdersData.fulfillment_orders;
    console.log(`📦 Fandt ${fulfillment_orders?.length || 0} fulfillment orders`);
    
    if (!fulfillment_orders || fulfillment_orders.length === 0) {
      throw new Error('Ingen fulfillment orders fundet');
    }
    
    // Tag første fulfillment order
    const fulfillmentOrder = fulfillment_orders[0];
    console.log('🎯 Bruger fulfillment order:', {
      id: fulfillmentOrder.id,
      status: fulfillmentOrder.status,
      location: fulfillmentOrder.assigned_location?.name
    });
    
    // STEP 2: Håndter multiple tracking numre
    const trackingNumbers = trackingNumber.split(',').map(num => num.trim());
    const trackingUrls = [];
    
    console.log(`📦 Håndterer ${trackingNumbers.length} tracking numre`);
    
    // Generer separate URLs for hvert tracking nummer
    trackingNumbers.forEach(num => {
      let individualUrl = '';
      
      // Byg URL baseret på carrier type
      if (carrier === 'DPD' || carrier === 'DPD_DE') {
        individualUrl = `https://tracking.dpd.de/parcelstatus?query=${num}`;
      } else if (carrier === 'GLS') {
        individualUrl = `https://gls-group.eu/EU/en/parcel-tracking?match=${num}`;
      } else if (carrier === 'PostNord') {
        individualUrl = `https://www.postnord.dk/en/track-and-trace?id=${num}`;
      } else if (carrier === 'DAO') {
        individualUrl = `https://www.dao.as/tracking?code=${num}`;
      } else if (carrier === 'Bring') {
        individualUrl = `https://tracking.bring.com/tracking.html?q=${num}`;
      } else if (carrier === 'UPS') {
        individualUrl = `https://www.ups.com/track?tracknum=${num}`;
      } else if (carrier === 'DHL') {
        individualUrl = `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
      } else {
        // Fallback - brug original URL logik
        if (trackingUrl.includes('query=')) {
          individualUrl = trackingUrl.replace(/query=.*/, `query=${num}`);
        } else if (trackingUrl.includes('match=')) {
          individualUrl = trackingUrl.replace(/match=.*/, `match=${num}`);
        } else {
          individualUrl = `${trackingUrl}${num}`;
        }
      }
      
      trackingUrls.push(individualUrl);
      console.log(`   📌 Tracking ${num} → ${individualUrl}`);
    });
    
    console.log('🔗 Genererede tracking URLs:', trackingUrls);
    
    // STEP 3: Opret fulfillment med nye API format - ÆNDRET HER
    const fulfillmentData = {
      fulfillment: {
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_id: fulfillmentOrder.id,
            fulfillment_order_line_items: fulfillmentOrder.line_items.map(item => ({
              id: item.id,
              quantity: item.quantity
            }))
          }
        ],
        tracking_numbers: trackingNumbers, // Array af tracking numre
        tracking_urls: trackingUrls,       // Array af URLs
        tracking_company: carrier,         // Carrier navn
        notify_customer: true
      }
    };
    
    console.log('📤 Opretter fulfillment...');
    
    const fulfillmentResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/fulfillments.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fulfillmentData)
      }
    );
    
    const fulfillmentResponseText = await fulfillmentResponse.text();
    console.log('Fulfillment response status:', fulfillmentResponse.status);
    
    if (!fulfillmentResponse.ok) {
      throw new Error(`Fulfillment error ${fulfillmentResponse.status}: ${fulfillmentResponseText}`);
    }
    
    const result = JSON.parse(fulfillmentResponseText);
    console.log('✅ SUCCESS! Fulfillment oprettet:', result.fulfillment?.id);
    
    return res.json({
      success: true,
      message: 'Fulfillment oprettet og tracking email sendt!',
      order: {
        name: order.name,
        id: order.id,
        customer: order.email
      },
      fulfillment: {
        id: result.fulfillment?.id,
        tracking_numbers: trackingNumbers,
        tracking_urls: trackingUrls,
        tracking_company: carrier,
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
