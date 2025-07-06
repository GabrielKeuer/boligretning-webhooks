export default async function handler(req, res) {
  const TEST_MODE = process.env.TEST_MODE === 'true';
  
  if (TEST_MODE) {
    console.log('🧪 KØRER I TEST MODE - INGEN EMAILS SENDES!');
  }
  
  // SIKKERHED: Tjek secret key så ikke hvem som helst kan køre denne
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('🔄 Starter VidaXL tracking sync...');
  
  try {
    // Hent ordrer fra VidaXL (sidste 7 dage eller 1 dag i test)
    const daysBack = TEST_MODE ? 1 : 7;
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - daysBack);
    const dateString = dateLimit.toISOString().split('T')[0];
    
    const vidaxlResponse = await fetch(
      `https://b2b.vidaxl.com/api_customer/orders?submitted_at_gteq=${dateString}`,
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.VIDAXL_EMAIL}:${process.env.VIDAXL_API_TOKEN}`).toString('base64')
        }
      }
    );
    
    let vidaxlOrders = await vidaxlResponse.json();
    
    // I test mode - max 5 ordrer
    if (TEST_MODE && vidaxlOrders.length > 5) {
      console.log(`⚠️ TEST MODE: Kun checker 5 ordrer (ud af ${vidaxlOrders.length})`);
      vidaxlOrders = vidaxlOrders.slice(0, 5);
    }
    
    console.log(`📦 Fandt ${vidaxlOrders.length} VidaXL ordrer`);
    
    let results = [];
    
    for (const item of vidaxlOrders) {
      const order = item.order;
      
      console.log(`\n🔍 Checker ordre:`, {
        reference: order.customer_order_reference,
        status: order.status_order_name,
        tracking: order.shipping_tracking || 'Ingen'
      });
      
      // Kun ordrer der er sendt og har tracking
      if (order.status_order_name === 'Sent' && order.shipping_tracking) {
        
        if (TEST_MODE) {
          // TEST MODE: Vis hvad der VILLE ske
          console.log('🧪 TEST MODE - Ville gøre:', {
            ordre: order.customer_order_reference,
            tracking: order.shipping_tracking,
            kunde: order.customer_email,
            handling: 'Oprette fulfillment og sende tracking email'
          });
          
          results.push({
            ordre: order.customer_order_reference,
            status: 'TEST - ikke sendt',
            tracking: order.shipping_tracking
          });
          
        } else {
          // LIVE MODE: Faktisk handling
          try {
            const shopifyOrder = await findShopifyOrder(order.customer_order_reference);
            
            if (!shopifyOrder) {
              results.push({
                ordre: order.customer_order_reference,
                status: 'Ikke fundet i Shopify'
              });
              continue;
            }
            
            if (shopifyOrder.fulfillment_status === 'fulfilled') {
              results.push({
                ordre: order.customer_order_reference,
                status: 'Allerede fulfilled'
              });
              continue;
            }
            
            await createShopifyFulfillment(shopifyOrder.id, {
              tracking_number: order.shipping_tracking,
              tracking_url: order.shipping_tracking_url,
              tracking_company: detectCarrier(order.shipping_tracking_url)
            });
            
            results.push({
              ordre: order.customer_order_reference,
              status: 'Fulfilled og email sendt',
              tracking: order.shipping_tracking
            });
            
          } catch (error) {
            results.push({
              ordre: order.customer_order_reference,
              status: 'Fejl',
              error: error.message
            });
          }
        }
      }
    }
    
    return res.status(200).json({
      mode: TEST_MODE ? 'TEST' : 'LIVE',
      ordrer_checket: vidaxlOrders.length,
      resultater: results
    });
    
  } catch (error) {
    console.error('❌ Fatal fejl:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function findShopifyOrder(orderName) {
  try {
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=${orderName}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const data = await response.json();
    return data.orders?.[0] || null;
    
  } catch (error) {
    console.error('Shopify søgefejl:', error);
    return null;
  }
}

async function createShopifyFulfillment(orderId, trackingInfo) {
  const fulfillmentData = {
    fulfillment: {
      location_id: "pending",
      tracking_number: trackingInfo.tracking_number,
      tracking_urls: [trackingInfo.tracking_url],
      tracking_company: trackingInfo.tracking_company,
      notify_customer: true, // Sender tracking email!
      line_items: []
    }
  };
  
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}/fulfillments.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fulfillmentData)
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(JSON.stringify(error.errors || error));
  }
  
  return response.json();
}

function detectCarrier(trackingUrl) {
  if (!trackingUrl) return 'Other';
  const url = trackingUrl.toLowerCase();
  if (url.includes('postnord')) return 'PostNord';
  if (url.includes('gls')) return 'GLS';
  if (url.includes('dao')) return 'DAO';
  if (url.includes('ups')) return 'UPS';
  if (url.includes('dhl')) return 'DHL';
  if (url.includes('dpd')) return 'DPD';  // ← TILFØJ DENNE
  if (url.includes('bring')) return 'Bring';  // Hvis I også bruger Bring
  return 'Other';
}
