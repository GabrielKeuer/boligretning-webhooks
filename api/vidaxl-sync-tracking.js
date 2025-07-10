// api/vidaxl-sync-tracking.js
export default async function handler(req, res) {
  // Kun tillad med korrekt CRON_SECRET
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const TEST_MODE = process.env.TEST_MODE === 'true';
  
  console.log(`🔄 VidaXL Tracking Sync Started (${TEST_MODE ? 'TEST MODE' : 'LIVE MODE'})`);
  
  try {
    // STEP 1: Hent ordrer fra VidaXL (sidste 7 dage))
    const ordersFromVidaXL = await fetchVidaXLOrders();
    console.log(`📦 Fandt ${ordersFromVidaXL.length} ordrer i VidaXL`);
    
    const results = {
      processed: 0,
      fulfilled: 0,
      skipped: 0,
      errors: []
    };
    
    // STEP 2: Process hver ordre
    for (const item of ordersFromVidaXL) {
      const order = item.order; // VidaXL struktur
      
      try {
        // Skip ordrer uden tracking eller ikke sendt
        if (order.status_order_name !== 'Sent' || !order.shipping_tracking) {
          console.log(`   ⏭️  Springer over: ${order.customer_order_reference} (status: ${order.status_order_name})`);
          results.skipped++;
          continue;
        }
        
        console.log(`\n📋 Processing VidaXL ordre:`);
        console.log(`   Reference: ${order.customer_order_reference}`);
        console.log(`   Tracking: ${order.shipping_tracking}`);
        console.log(`   URL: ${order.shipping_tracking_url || 'Ingen URL'}`);
        console.log(`   Carrier: ${order.shipping_option_name || 'Ukendt'}`);
        
        // Find Shopify ordre
        const shopifyOrder = await findShopifyOrder(order.customer_order_reference);
        
        if (!shopifyOrder) {
          console.log(`   ❌ Shopify ordre ikke fundet`);
          results.errors.push({
            vidaxl_order: order.order_number,
            reference: order.customer_order_reference,
            error: 'Shopify ordre ikke fundet'
          });
          continue;
        }
        
        console.log(`   ✅ Fandt Shopify ordre: ${shopifyOrder.name} (ID: ${shopifyOrder.id})`);
        
        // SIKKERHEDSTJEK: Verificer at vi fandt den RIGTIGE ordre
        if (order.customer_order_reference.startsWith('#')) {
          if (shopifyOrder.name !== order.customer_order_reference) {
            console.error(`   🚨 ORDRE MISMATCH DETECTED!`);
            console.error(`      VidaXL reference: ${order.customer_order_reference}`);
            console.error(`      Shopify ordre fundet: ${shopifyOrder.name}`);
            console.error(`      STOPPER PROCESSING AF DENNE ORDRE!`);
            
            results.errors.push({
              vidaxl_order: order.order_number,
              reference: order.customer_order_reference,
              error: `Ordre mismatch: VidaXL=${order.customer_order_reference}, Shopify=${shopifyOrder.name}`,
              CRITICAL: true
            });
            continue; // Skip denne ordre helt
          }
        }
        
        // Check om allerede fulfilled
        if (shopifyOrder.fulfillment_status === 'fulfilled') {
          console.log(`   ⏭️  Ordre allerede fulfilled`);
          results.skipped++;
          continue;
        }
        
        // Opret fulfillment med GraphQL
        if (!TEST_MODE) {
          const fulfillmentResult = await createGraphQLFulfillment(
            shopifyOrder,
            order.shipping_tracking,
            order.shipping_tracking_url,
            order.shipping_option_name || detectCarrier(order.shipping_tracking_url)
          );
          
          if (fulfillmentResult.success) {
            console.log(`   ✅ Fulfillment oprettet med ID: ${fulfillmentResult.fulfillmentId}`);
            results.fulfilled++;
          } else {
            throw new Error(fulfillmentResult.error);
          }
        } else {
          console.log(`   🧪 TEST MODE: Ville oprette fulfillment`);
          console.log(`      Tracking: ${order.shipping_tracking}`);
          console.log(`      URL: ${order.shipping_tracking_url || 'Ingen'}`);
          console.log(`      Multiple URLs:`, order.shipping_tracking_urls_by_number);
          results.fulfilled++;
        }
        
        results.processed++;
        
      } catch (orderError) {
        console.error(`   ❌ Fejl for ordre ${order.customer_order_reference}:`, orderError.message);
        results.errors.push({
          vidaxl_order: order.order_number || 'Ukendt',
          reference: order.customer_order_reference,
          error: orderError.message
        });
      }
    }
    
    // STEP 3: Send rapport email hvis der er opdateringer eller fejl
    if (results.fulfilled > 0 || results.errors.length > 0) {
      await sendSyncReport(results);
    }
    
    console.log('\n📊 Sync Complete:', results);
    
    return res.json({
      success: true,
      message: 'VidaXL tracking sync completed',
      results
    });
    
  } catch (error) {
    console.error('❌ Sync fejl:', error);
    
    // Send fejl email
    await sendErrorEmail('VidaXL Sync Fejl', error.message);
    
    return res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Hent ordrer fra VidaXL API - KORREKT ENDPOINT OG STRUKTUR
async function fetchVidaXLOrders() {
  // Hent ordrer fra sidste 7 dage
  const daysBack = process.env.TEST_MODE === 'true' ? 1 : 7;
  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - daysBack);
  const dateString = dateLimit.toISOString().split('T')[0];
  
  console.log(`📅 Henter ordrer fra: ${dateString}`);
  
  const response = await fetch(
    `https://b2b.vidaxl.com/api_customer/orders?submitted_at_gteq=${dateString}`,
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${process.env.VIDAXL_EMAIL}:${process.env.VIDAXL_API_TOKEN}`).toString('base64')
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`VidaXL API error: ${response.status}`);
  }
  
  let vidaxlOrders = await response.json();
  
 // Test mode - vis alle ordrer
if (process.env.TEST_MODE === 'true') {
  console.log(`⚠️ TEST MODE: Checker alle ${vidaxlOrders.length} ordrer`);
}
  
  return vidaxlOrders;
}

// Find Shopify ordre baseret på reference - MED EXACT MATCH FIX
async function findShopifyOrder(orderReference) {
  try {
    // Check om det er et ordre nummer (starter med #36)
    if (orderReference.startsWith('#36') || orderReference.startsWith('36')) {
      const orderName = orderReference.startsWith('#') ? orderReference : `#${orderReference}`;
      console.log(`🔍 Søger efter ordre nummer: ${orderName}`);
      
      // Shopify's search API kan returnere multiple matches
      const searchResponse = await fetch(
        `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=250`,
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const searchData = await searchResponse.json();
      
      if (searchData.orders && searchData.orders.length > 0) {
        console.log(`   Shopify returnerede ${searchData.orders.length} ordre(r)`);
        
        // KRITISK: Find EXACT match - ikke bare den første!
        const exactMatch = searchData.orders.find(order => 
          order.name.toLowerCase() === orderName.toLowerCase()
        );
        
        if (exactMatch) {
          console.log(`✅ Fandt EXACT match: ${exactMatch.name} (ID: ${exactMatch.id})`);
          return exactMatch;
        } else {
          // Log alle returnerede ordrer for debugging
          console.log(`❌ INGEN EXACT MATCH for ${orderName}!`);
          console.log(`   Shopify returnerede disse ordre:`, 
            searchData.orders.map(o => ({
              name: o.name,
              id: o.id,
              created_at: o.created_at
            }))
          );
          return null;
        }
      } else {
        console.log(`   Ingen ordrer fundet for ${orderName}`);
        return null;
      }
      
    } else {
      // Det er et ordre ID - hent direkte (dette virker fint)
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
      } else {
        console.log(`❌ Ordre med ID ${orderReference} ikke fundet`);
        return null;
      }
    }
    
  } catch (error) {
    console.error('❌ Shopify søgefejl:', error);
    return null;
  }
}

// Opret fulfillment med GraphQL - EXACT KOPI FRA TEST-FULFILLMENT-GRAPHQL.JS
async function createGraphQLFulfillment(order, trackingNumber, trackingUrl, carrier) {
  try {
    // STEP 1: Hent fulfillment orders via GraphQL
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
    
    // STEP 2: Håndter multiple tracking numre med AUTO-DETECTION (KOPI FRA TEST)
    const trackingNumbers = trackingNumber.split(',').map(num => num.trim());
    const trackingDataArray = [];
    
    console.log(`📦 Håndterer ${trackingNumbers.length} tracking numre`);
    
    // Auto-detect carrier for hvert tracking nummer
    trackingNumbers.forEach(num => {
      let detectedCarrier = carrier; // Default carrier fra input
      let individualUrl = '';
      
      // Auto-detect baseret på format
      if (num.match(/^\d{14,15}$/)) {
        // DPD format: 14-15 cifre
        detectedCarrier = 'DPD';
        individualUrl = `https://tracking.dpd.de/parcelstatus?query=${num}`;
      } else if (num.match(/^[A-Z0-9]{8}$/)) {
        // GLS format: 8 alfanumeriske karakterer
        detectedCarrier = 'GLS';
        individualUrl = `https://gls-group.eu/EU/en/parcel-tracking?match=${num}`;
      } else if (num.match(/^\d{18}$/)) {
        // PostNord format: 18 cifre
        detectedCarrier = 'PostNord';
        individualUrl = `https://www.postnord.dk/en/track-and-trace?id=${num}`;
      } else if (num.match(/^7\d{13}$/)) {
        // DAO format: starter med 7 og har 14 cifre
        detectedCarrier = 'DAO';
        individualUrl = `https://www.dao.as/tracking?code=${num}`;
      } else if (num.match(/^1Z[A-Z0-9]+$/)) {
        // UPS format: starter med 1Z
        detectedCarrier = 'UPS';
        individualUrl = `https://www.ups.com/track?tracknum=${num}`;
      } else if (num.match(/^\d{10}$/)) {
        // DHL format: 10 cifre
        detectedCarrier = 'DHL';
        individualUrl = `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
      } else if (trackingUrl && trackingUrl.includes(',')) {
        // Hvis URL har komma-separerede numre, split og match
        if (trackingUrl.includes('query=')) {
          individualUrl = trackingUrl.replace(/query=[\d,]+/, `query=${num}`);
        } else if (trackingUrl.includes('match=')) {
          individualUrl = trackingUrl.replace(/match=[\w,]+/, `match=${num}`);
        } else {
          individualUrl = trackingUrl;
        }
      } else {
        // Fallback: brug input URL
        individualUrl = trackingUrl || '';
      }
      
      trackingDataArray.push({
        number: num,
        carrier: detectedCarrier,
        url: individualUrl
      });
      
      console.log(`   📌 ${num} → Detected: ${detectedCarrier} → ${individualUrl}`);
    });
    
    // Check om alle har samme carrier
    const uniqueCarriers = [...new Set(trackingDataArray.map(t => t.carrier))];
    
    if (uniqueCarriers.length > 1) {
      console.log('⚠️ ADVARSEL: Multiple carriers detected:', uniqueCarriers);
      console.log('📝 Shopify understøtter kun én carrier per fulfillment');
      console.log('🔄 Bruger mest almindelige carrier eller første:', trackingDataArray[0].carrier);
    }
    
    // Find mest almindelige carrier eller brug første
    const carrierCounts = {};
    trackingDataArray.forEach(t => {
      carrierCounts[t.carrier] = (carrierCounts[t.carrier] || 0) + 1;
    });
    const finalCarrier = Object.keys(carrierCounts).reduce((a, b) => 
      carrierCounts[a] > carrierCounts[b] ? a : b
    );
    
    // Ekstrahér tracking URLs
    const trackingUrls = trackingDataArray.map(t => t.url);
    
    // STEP 3: Opret fulfillment med GraphQL mutation
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
    
    // Byg line items array
    const lineItems = fulfillmentOrder.lineItems.edges.map(edge => ({
      id: edge.node.id,
      quantity: edge.node.remainingQuantity
    }));
    
    // Byg fulfillment input - EXACT SAMME STRUKTUR SOM TEST
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
          company: finalCarrier,
          numbers: trackingNumbers,  // Original array af tracking numre
          urls: trackingUrls        // Array af genererede URLs
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
    
    return {
      success: true,
      fulfillmentId: fulfillment.id
    };
    
  } catch (error) {
    console.error('❌ Fejl i createGraphQLFulfillment:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// GraphQL helper
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`,
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

// Detect carrier fra tracking URL
function detectCarrier(trackingUrl) {
  if (!trackingUrl) return 'Other';
  const url = trackingUrl.toLowerCase();
  
  if (url.includes('postnord')) return 'PostNord';
  if (url.includes('gls-group')) return 'GLS';
  if (url.includes('dao.as')) return 'DAO';
  if (url.includes('ups.com')) return 'UPS';
  if (url.includes('dhl.com')) return 'DHL';
  if (url.includes('dpd')) return 'DPD';
  if (url.includes('bring')) return 'Bring';
  if (url.includes('fedex')) return 'FedEx';
  
  return 'Other';
}

// Send sync rapport
async function sendSyncReport(results) {
  const emailHtml = `
    <h2>VidaXL Tracking Sync Rapport</h2>
    <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString('da-DK')}</p>
    
    <h3>Resultater:</h3>
    <ul>
      <li>Behandlet: ${results.processed} ordrer</li>
      <li>Fulfilled: ${results.fulfilled} ordrer</li>
      <li>Sprunget over: ${results.skipped} ordrer</li>
      <li>Fejl: ${results.errors.length} ordrer</li>
    </ul>
    
    ${results.errors.length > 0 ? `
      <h3>Fejl:</h3>
      <table border="1" style="border-collapse: collapse;">
        <tr>
          <th>VidaXL Ordre</th>
          <th>Reference</th>
          <th>Fejl</th>
          <th>Kritisk</th>
        </tr>
        ${results.errors.map(err => `
          <tr style="${err.CRITICAL ? 'background-color: #ffcccc;' : ''}">
            <td>${err.vidaxl_order}</td>
            <td>${err.reference}</td>
            <td>${err.error}</td>
            <td>${err.CRITICAL ? '⚠️ JA' : 'Nej'}</td>
          </tr>
        `).join('')}
      </table>
    ` : ''}
    
    ${results.errors.some(e => e.CRITICAL) ? `
      <p style="color: red; font-weight: bold;">
        ⚠️ ADVARSEL: Der er kritiske fejl med ordre mismatch! 
        Check logs øjeblikkeligt.
      </p>
    ` : ''}
  `;
  
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
        subject: `Tracking Sync: ${results.fulfilled} ordrer opdateret${results.errors.some(e => e.CRITICAL) ? ' ⚠️ KRITISK FEJL' : ''}`,
        html: emailHtml
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Email fejl:', error);
    }
  } catch (error) {
    console.error('Email fejl:', error);
  }
}

// Send fejl email
async function sendErrorEmail(subject, error) {
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
        subject: `❌ ${subject}`,
        html: `
          <h2>Fejl i VidaXL Integration</h2>
          <p><strong>Fejl:</strong> ${error}</p>
          <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString('da-DK')}</p>
          <p>Check logs i Vercel dashboard for flere detaljer.</p>
        `
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Kunne ikke sende fejl email:', error);
    }
  } catch (emailError) {
    console.error('Kunne ikke sende fejl email:', emailError);
  }
}
