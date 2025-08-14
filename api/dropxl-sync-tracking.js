// api/dropxl-sync-tracking.js

// Tilladt vendor liste - DropXL håndterer disse brands
const DROPXL_VENDORS = ['vidaXL', 'VidaXL', 'vidaxl', 'Bestway', 'bestway', 'Keter', 'keter'];

export default async function handler(req, res) {
  // Kun tillad med korrekt CRON_SECRET
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const TEST_MODE = process.env.TEST_MODE === 'true';
  
  console.log(`🔄 DropXL Tracking Sync Started (${TEST_MODE ? 'TEST MODE' : 'LIVE MODE'})`);
  
  try {
    // STEP 1: Hent ordrer fra DropXL (sidste 7 dage)
    const ordersFromDropXL = await fetchDropXLOrders();
    console.log(`📦 Fandt ${ordersFromDropXL.length} ordrer i DropXL`);
    
    const results = {
      processed: 0,
      fulfilled: 0,
      partialFulfilled: 0,
      skipped: 0,
      errors: []
    };
    
    // STEP 2: Process hver ordre
    for (const item of ordersFromDropXL) {
      const order = item.order; // DropXL struktur
      
      try {
        // Skip ordrer uden tracking eller ikke sendt
        if (order.status_order_name !== 'Sent' || !order.shipping_tracking) {
          console.log(`   ⏭️  Springer over: ${order.customer_order_reference} (status: ${order.status_order_name})`);
          results.skipped++;
          continue;
        }
        
        console.log(`\n📋 Processing DropXL ordre:`);
        console.log(`   Reference: ${order.customer_order_reference}`);
        console.log(`   Tracking: ${order.shipping_tracking}`);
        console.log(`   URL: ${order.shipping_tracking_url || 'Ingen URL'}`);
        console.log(`   Carrier: ${order.shipping_option_name || 'Ukendt'}`);
        
        // VIGTIGT: Hent SKUs fra DropXL ordre produkter
        const dropxlSKUs = [];
        if (order.order_products && Array.isArray(order.order_products)) {
          order.order_products.forEach(product => {
            if (product.order_product) {
              dropxlSKUs.push(product.order_product.product_code);
            }
          });
        }
        console.log(`   📦 DropXL SKUs i ordre:`, dropxlSKUs);
        
        // Find Shopify ordre
        const shopifyOrder = await findShopifyOrder(order.customer_order_reference);
        
        if (!shopifyOrder) {
          console.log(`   ❌ Shopify ordre ikke fundet`);
          results.errors.push({
            dropxl_order: order.id,
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
            console.error(`      DropXL reference: ${order.customer_order_reference}`);
            console.error(`      Shopify ordre fundet: ${shopifyOrder.name}`);
            console.error(`      STOPPER PROCESSING AF DENNE ORDRE!`);
            
            results.errors.push({
              dropxl_order: order.id,
              reference: order.customer_order_reference,
              error: `Ordre mismatch: DropXL=${order.customer_order_reference}, Shopify=${shopifyOrder.name}`,
              CRITICAL: true
            });
            continue;
          }
        }
        
        // Check om allerede fulfilled
        if (shopifyOrder.fulfillment_status === 'fulfilled') {
          console.log(`   ⏭️  Ordre allerede fulfilled`);
          results.skipped++;
          continue;
        }
        
        // PARTIAL FULFILLMENT CHECK: Identificer hvilke produkter der skal fulfilles
        const isPartialOrder = checkIfPartialOrder(shopifyOrder, dropxlSKUs);
        
        if (isPartialOrder) {
          console.log(`   📊 PARTIAL FULFILLMENT PÅKRÆVET!`);
          console.log(`      Total produkter i Shopify: ${shopifyOrder.line_items.length}`);
          console.log(`      DropXL produkter: ${dropxlSKUs.length}`);
        }
        
        // Opret fulfillment med GraphQL (nu med partial support)
        if (!TEST_MODE) {
          const fulfillmentResult = await createPartialGraphQLFulfillment(
            shopifyOrder,
            dropxlSKUs,  // Send SKUs så vi kan matche
            order.shipping_tracking,
            order.shipping_tracking_url,
            order.shipping_option_name || detectCarrier(order.shipping_tracking_url)
          );
          
          if (fulfillmentResult.success) {
            console.log(`   ✅ Fulfillment oprettet med ID: ${fulfillmentResult.fulfillmentId}`);
            if (fulfillmentResult.isPartial) {
              console.log(`   📦 Partial fulfillment: ${fulfillmentResult.itemsFulfilled} af ${fulfillmentResult.itemsTotal} produkter`);
              results.partialFulfilled++;
            } else {
              results.fulfilled++;
            }
          } else {
            throw new Error(fulfillmentResult.error);
          }
        } else {
          console.log(`   🧪 TEST MODE: Ville oprette ${isPartialOrder ? 'PARTIAL' : 'FULL'} fulfillment`);
          console.log(`      Tracking: ${order.shipping_tracking}`);
          console.log(`      URL: ${order.shipping_tracking_url || 'Ingen'}`);
          console.log(`      DropXL SKUs:`, dropxlSKUs);
          if (isPartialOrder) {
            results.partialFulfilled++;
          } else {
            results.fulfilled++;
          }
        }
        
        results.processed++;
        
      } catch (orderError) {
        console.error(`   ❌ Fejl for ordre ${order.customer_order_reference}:`, orderError.message);
        results.errors.push({
          dropxl_order: order.id || 'Ukendt',
          reference: order.customer_order_reference,
          error: orderError.message
        });
      }
    }
    
    // STEP 3: Send rapport email hvis der er opdateringer eller fejl
    if (results.fulfilled > 0 || results.partialFulfilled > 0 || results.errors.length > 0) {
      await sendSyncReport(results);
    }
    
    console.log('\n📊 Sync Complete:', results);
    
    return res.json({
      success: true,
      message: 'DropXL tracking sync completed',
      results
    });
    
  } catch (error) {
    console.error('❌ Sync fejl:', error);
    
    // Send fejl email
    await sendErrorEmail('DropXL Sync Fejl', error.message);
    
    return res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Check om ordre skal have partial fulfillment
function checkIfPartialOrder(shopifyOrder, dropxlSKUs) {
  // Hvis DropXL ikke har alle SKUs fra Shopify ordren, er det partial
  const shopifySKUs = shopifyOrder.line_items.map(item => item.sku).filter(sku => sku);
  
  // Check om alle Shopify SKUs er i DropXL listen
  const missingInDropXL = shopifySKUs.filter(sku => !dropxlSKUs.includes(sku));
  
  if (missingInDropXL.length > 0) {
    console.log(`   📝 Følgende SKUs er IKKE hos DropXL:`, missingInDropXL);
    return true;
  }
  
  return false;
}

// Hent ordrer fra DropXL API
async function fetchDropXLOrders() {
  // Hent ordrer fra sidste 7 dage
  const daysBack = process.env.TEST_MODE === 'true' ? 1 : 7;
  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - daysBack);
  const dateString = dateLimit.toISOString().split('T')[0];
  
  console.log(`📅 Henter ordrer fra: ${dateString}`);
  
  const response = await fetch(
    `https://b2b.dropxl.com/api_customer/orders?submitted_at_gteq=${dateString}`,
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${process.env.DROPXL_EMAIL}:${process.env.DROPXL_API_TOKEN}`).toString('base64')
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`DropXL API error: ${response.status}`);
  }
  
  let dropxlOrders = await response.json();
  
  if (process.env.TEST_MODE === 'true') {
    console.log(`⚠️ TEST MODE: Checker alle ${dropxlOrders.length} ordrer`);
  }
  
  return dropxlOrders;
}

// Find Shopify ordre baseret på reference
async function findShopifyOrder(orderReference) {
  try {
    if (orderReference.startsWith('#36') || orderReference.startsWith('36')) {
      const orderName = orderReference.startsWith('#') ? orderReference : `#${orderReference}`;
      console.log(`🔍 Søger efter ordre nummer: ${orderName}`);
      
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
        
        const exactMatch = searchData.orders.find(order => 
          order.name.toLowerCase() === orderName.toLowerCase()
        );
        
        if (exactMatch) {
          console.log(`✅ Fandt EXACT match: ${exactMatch.name} (ID: ${exactMatch.id})`);
          return exactMatch;
        } else {
          console.log(`❌ INGEN EXACT MATCH for ${orderName}!`);
          return null;
        }
      } else {
        console.log(`   Ingen ordrer fundet for ${orderName}`);
        return null;
      }
      
    } else {
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

// OPDATERET: Opret partial fulfillment med GraphQL
async function createPartialGraphQLFulfillment(order, dropxlSKUs, trackingNumber, trackingUrl, carrier) {
  try {
    // STEP 1: Hent fulfillment orders via GraphQL
    const fulfillmentOrdersQuery = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          lineItems(first: 50) {
            edges {
              node {
                id
                sku
                vendor
                name
              }
            }
          }
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
                        sku
                        vendor
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
    const allLineItems = foResponse.data.order.lineItems.edges;
    
    if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
      throw new Error('Ingen fulfillment orders fundet');
    }
    
    const fulfillmentOrder = fulfillmentOrders[0].node;
    console.log('🎯 Bruger fulfillment order:', fulfillmentOrder.id);
    
    // STEP 2: FILTRER line items baseret på DropXL SKUs OG vendor
    const lineItemsToFulfill = [];
    let skippedItems = [];
    
    fulfillmentOrder.lineItems.edges.forEach(edge => {
      const lineItem = edge.node;
      const sku = lineItem.lineItem.sku;
      const vendor = lineItem.lineItem.vendor;
      const name = lineItem.lineItem.name;
      
      // Check om SKU er i DropXL listen OG vendor er korrekt
      if (dropxlSKUs.includes(sku) && DROPXL_VENDORS.includes(vendor)) {
        if (lineItem.remainingQuantity > 0) {
          lineItemsToFulfill.push({
            id: lineItem.id,
            quantity: lineItem.remainingQuantity
          });
          console.log(`   ✅ Inkluderer: ${sku} - ${name} (Qty: ${lineItem.remainingQuantity})`);
        }
      } else {
        skippedItems.push(`${sku} - ${name} (Vendor: ${vendor || 'Ingen'})`);
        console.log(`   ⏭️ Springer over: ${sku} - ${name} (Vendor: ${vendor || 'Ingen'})`);
      }
    });
    
    if (lineItemsToFulfill.length === 0) {
      throw new Error('Ingen DropXL produkter at fulfill i denne ordre');
    }
    
    const isPartialFulfillment = skippedItems.length > 0;
    
    if (isPartialFulfillment) {
      console.log(`   📊 PARTIAL FULFILLMENT:`);
      console.log(`      Fulfilling: ${lineItemsToFulfill.length} produkter`);
      console.log(`      Skipping: ${skippedItems.length} produkter`);
    }
    
    // STEP 3: Håndter tracking numre
    const trackingNumbers = trackingNumber.split(',').map(num => num.trim());
    const trackingDataArray = [];
    
    console.log(`📦 Håndterer ${trackingNumbers.length} tracking numre`);
    
    trackingNumbers.forEach(num => {
      let detectedCarrier = carrier;
      let individualUrl = '';
      
      // Auto-detect carrier baseret på format
      if (num.match(/^\d{14,15}$/)) {
        detectedCarrier = 'DPD';
        individualUrl = `https://tracking.dpd.de/parcelstatus?query=${num}`;
      } else if (num.match(/^[A-Z0-9]{8}$/)) {
        detectedCarrier = 'GLS';
        individualUrl = `https://gls-group.eu/EU/en/parcel-tracking?match=${num}`;
      } else if (num.match(/^\d{18}$/)) {
        detectedCarrier = 'PostNord';
        individualUrl = `https://www.postnord.dk/en/track-and-trace?id=${num}`;
      } else if (num.match(/^7\d{13}$/)) {
        detectedCarrier = 'DAO';
        individualUrl = `https://www.dao.as/tracking?code=${num}`;
      } else if (num.match(/^1Z[A-Z0-9]+$/)) {
        detectedCarrier = 'UPS';
        individualUrl = `https://www.ups.com/track?tracknum=${num}`;
      } else if (num.match(/^\d{10}$/)) {
        detectedCarrier = 'DHL';
        individualUrl = `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
      } else {
        individualUrl = trackingUrl || '';
      }
      
      trackingDataArray.push({
        number: num,
        carrier: detectedCarrier,
        url: individualUrl
      });
      
      console.log(`   📌 ${num} → Detected: ${detectedCarrier}`);
    });
    
    const uniqueCarriers = [...new Set(trackingDataArray.map(t => t.carrier))];
    const finalCarrier = uniqueCarriers.length === 1 ? uniqueCarriers[0] : trackingDataArray[0].carrier;
    const trackingUrls = trackingDataArray.map(t => t.url);
    
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
    
    const fulfillmentInput = {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: fulfillmentOrder.id,
            fulfillmentOrderLineItems: lineItemsToFulfill  // KUN DropXL produkter
          }
        ],
        notifyCustomer: true,
        trackingInfo: {
          company: finalCarrier,
          numbers: trackingNumbers,
          urls: trackingUrls
        }
      }
    };
    
    console.log('📤 Opretter fulfillment med GraphQL');
    
    const result = await shopifyGraphQL(createFulfillmentMutation, fulfillmentInput);
    
    if (result.data.fulfillmentCreateV2.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.data.fulfillmentCreateV2.userErrors));
    }
    
    const fulfillment = result.data.fulfillmentCreateV2.fulfillment;
    console.log('✅ SUCCESS! Fulfillment oprettet:', fulfillment.id);
    
    return {
      success: true,
      fulfillmentId: fulfillment.id,
      isPartial: isPartialFulfillment,
      itemsFulfilled: lineItemsToFulfill.length,
      itemsTotal: fulfillmentOrder.lineItems.edges.length
    };
    
  } catch (error) {
    console.error('❌ Fejl i createPartialGraphQLFulfillment:', error.message);
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

// Send sync rapport - OPDATERET med partial fulfillment info
async function sendSyncReport(results) {
  const emailHtml = `
    <h2>DropXL Tracking Sync Rapport</h2>
    <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString('da-DK')}</p>
    
    <h3>Resultater:</h3>
    <ul>
      <li>Behandlet: ${results.processed} ordrer</li>
      <li>Fuldt fulfilled: ${results.fulfilled} ordrer</li>
      <li>Delvist fulfilled: ${results.partialFulfilled} ordrer</li>
      <li>Sprunget over: ${results.skipped} ordrer</li>
      <li>Fejl: ${results.errors.length} ordrer</li>
    </ul>
    
    ${results.partialFulfilled > 0 ? `
      <p style="background: #fffbf0; padding: 10px; border-left: 4px solid #ffa500;">
        📦 <strong>Note:</strong> ${results.partialFulfilled} ordrer havde produkter fra flere leverandører. 
        Kun DropXL produkter (vidaXL, Bestway, Keter) blev markeret som sendt.
      </p>
    ` : ''}
    
    ${results.errors.length > 0 ? `
      <h3>Fejl:</h3>
      <table border="1" style="border-collapse: collapse;">
        <tr>
          <th>DropXL Ordre</th>
          <th>Reference</th>
          <th>Fejl</th>
          <th>Kritisk</th>
        </tr>
        ${results.errors.map(err => `
          <tr style="${err.CRITICAL ? 'background-color: #ffcccc;' : ''}">
            <td>${err.dropxl_order}</td>
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
        subject: `Tracking Sync: ${results.fulfilled + results.partialFulfilled} ordrer opdateret${results.errors.some(e => e.CRITICAL) ? ' ⚠️ KRITISK FEJL' : ''}`,
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
          <h2>Fejl i DropXL Integration</h2>
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
