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
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

    let requiresRefund = false;

    for (const item of lineItems.data) {
      const productId = item.price.product;
      const quantityPurchased = item.quantity;
      const product = await stripe.products.retrieve(productId);
      
      if (product.metadata && product.metadata.stock !== undefined) {
        const currentStock = parseInt(product.metadata.stock);

        // --- DEFENSE LEVEL 2: THE FAILSAFE ---
        if (currentStock < quantityPurchased) {
            // Overdraft detected! Flag for refund and hard-stop stock at 0.
            requiresRefund = true;
            await stripe.products.update(productId, {
                metadata: { ...product.metadata, stock: '0' },
            });
        } else {
            // Normal deduction
            const newStock = currentStock - quantityPurchased;
            await stripe.products.update(productId, {
                metadata: { ...product.metadata, stock: newStock.toString() },
            });
        }
      }
    }

    // --- TRIGGER STRIPE AUTO-REFUND ---
    if (requiresRefund && session.payment_intent) {
        await stripe.refunds.create({
            payment_intent: session.payment_intent,
        });
    }
  }

  res.status(200).json({ received: true });
}