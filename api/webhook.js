const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata;

    if (metadata && metadata.item_count) {
      const itemCount = parseInt(metadata.item_count);
      let requiresRefund = false;

      for (let i = 0; i < itemCount; i++) {
        const priceId = metadata[`id_${i}`];
        const size = metadata[`size_${i}`];
        const color = metadata[`color_${i}`];
        const quantityPurchased = parseInt(metadata[`qty_${i}`]);

        const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
        const product = price.product;
        const hasVariants = product.metadata && product.metadata.hasVariants === 'true';

        if (hasVariants) {
          const stockKey = `stock_${size}_${color}`;
          if (product.metadata && product.metadata[stockKey] !== undefined) {
            const currentStock = parseInt(product.metadata[stockKey]);
            const updateData = { ...product.metadata };
            
            if (currentStock < quantityPurchased) {
              requiresRefund = true;
              updateData[stockKey] = '0';
            } else {
              updateData[stockKey] = (currentStock - quantityPurchased).toString();
            }
            await stripe.products.update(product.id, { metadata: updateData });
          }
        } else {
          if (product.metadata && product.metadata.stock !== undefined) {
            const currentStock = parseInt(product.metadata.stock);
            if (currentStock < quantityPurchased) {
              requiresRefund = true;
              await stripe.products.update(product.id, {
                metadata: { ...product.metadata, stock: '0' },
              });
            } else {
              const newStock = currentStock - quantityPurchased;
              await stripe.products.update(product.id, {
                metadata: { ...product.metadata, stock: newStock.toString() },
              });
            }
          }
        }
      }

      if (requiresRefund && session.payment_intent) {
        await stripe.refunds.create({
          payment_intent: session.payment_intent,
        });
      }
    }
  }

  res.status(200).json({ received: true });
}