export default async function handler(req, res) {
  // Test endpoint - kun med CRON_SECRET
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const orderNumber = req.body.order_number || "#362628";
  const trackingNumber = req.body.tracking || "YNZX9BHU";
  const trackingUrl = req.body.url || "https://gls-group.eu/EU/en/parcel-tracking?match=YNZX9BHU";
  const carrier = req.body.carrier || "GLS";
  
  console.log('🧪 TEST FULFILLMENT GRAPHQL for ordre:', orderNumber);
  
  try {
    // STEP 1: Find ordre ID via REST API først
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
      status: order.fulfillment_status
    });
    
    // STEP 2: Hent fulfillment orders via GraphQL
    const fulfillmentOrdersQuery = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      remainingQuantity
                      lineItem {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const gqlOrderId = `gid://shopify/Order/${order.id}`;
    
    const foResponse = await shopifyGraphQL(fulfillmentOrdersQuery, { orderId: gqlOrderId });
    const fulfillmentOrders = foResponse.data.order.fulfillmentOrders.edges;
    
    if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
      throw new Error('Ingen fulfillment orders fundet');
    }
    
    const fulfillmentOrder = fulfillmentOrders[0].node;
    console.log('🎯 Bruger fulfillment order:', fulfillmentOrder.id);
    
    // STEP 3: Håndter multiple tracking numre
    const trackingNumbers = trackingNumber.split(',').map(num => num.trim());
    const trackingUrls = [];
    
    console.log(`📦 Håndterer ${trackingNumbers.length} tracking numre`);
    
    // Generer separate URLs for hvert tracking nummer
    if (trackingNumbers.length > 1) {
      trackingNumbers.forEach(num => {
        let individualUrl = trackingUrl;
        
        if (trackingUrl.includes('query=')) {
          individualUrl = trackingUrl.replace(/query=[\d,]+/, `query=${num}`);
        } else if (trackingUrl.includes('match=')) {
          individualUrl = trackingUrl.replace(/match=[\w,]+/, `match=${num}`);
        }
        
        trackingUrls.push(individualUrl);
        console.log(`   📌 ${num} → ${individualUrl}`);
      });
    } else {
      trackingUrls.push(trackingUrl);
    }
    
    // STEP 4: Opret fulfillment med GraphQL mutation
    const createFulfillmentMutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
            trackingInfo(first: 10) {
              company
              number
              url
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    // Byg line items array med KORREKT struktur
    const lineItems = fulfillmentOrder.lineItems.edges.map(edge => ({
      id: edge.node.id,
      quantity: edge.node.remainingQuantity
    }));
    
    // Byg fulfillment input med KORREKT struktur
    const fulfillmentInput = {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: fulfillmentOrder.id,
            fulfillmentOrderLineItems: lineItems
          }
        ],
        notifyCustomer: true,
        trackingInfo: {
          company: carrier,
          numbers: trackingNumbers,  // ARRAY af tracking numre!
          urls: trackingUrls        // ARRAY af tracking URLs!
        }
      }
    };
    
    console.log('📤 Opretter fulfillment med GraphQL:', JSON.stringify(fulfillmentInput, null, 2));
    
    const result = await shopifyGraphQL(createFulfillmentMutation, fulfillmentInput);
    
    if (result.data.fulfillmentCreateV2.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.data.fulfillmentCreateV2.userErrors));
    }
    
    const fulfillment = result.data.fulfillmentCreateV2.fulfillment;
    console.log('✅ SUCCESS! Fulfillment oprettet:', fulfillment.id);
    
    return res.json({
      success: true,
      message: 'Fulfillment oprettet via GraphQL med multiple tracking!',
      order: {
        name: order.name,
        id: order.id
      },
      fulfillment: {
        id: fulfillment.id,
        status: fulfillment.status,
        trackingInfo: fulfillment.trackingInfo
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

// GraphQL helper funktion
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2025-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );
  
  const data = await response.json();
  
  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }
  
  return data;
}

// Genbrug samme findShopifyOrder funktion
async function findShopifyOrder(orderReference) {
  try {
    if (orderReference.startsWith('#36') || orderReference.startsWith('36')) {
      const orderName = orderReference.startsWith('#') ? orderReference : `#${orderReference}`;
      console.log(`🔍 Søger efter ordre nummer: ${orderName}`);
      
      const searchResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2025-01/orders.json?name=${orderName}&status=any`,
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
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2025-01/orders/${orderReference}.json`,
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
