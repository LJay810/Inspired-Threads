const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

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

  // EVENT-LEVEL IDEMPOTENCY (early check): has this exact event already been fully processed?
  // This key is only ever SET after everything below succeeds (see bottom of this handler).
  const eventKey = `evt_${event.id}`;
  const alreadyProcessed = await kv.get(eventKey);
  if (alreadyProcessed) {
    return res.status(200).json({ received: true, note: 'Duplicate event already processed' });
  }

  const session = event.data.object;
  const metadata = session.metadata;

  if (!metadata || !metadata.item_count) {
    return res.status(200).json({ received: true });
  }
  const itemCount = parseInt(metadata.item_count);

  try {
    // PAYMENT SUCCESSFUL: sync the live Redis count back into Stripe metadata as a cold-storage
    // backup. This is naturally idempotent (just re-copies the current value), so no per-item
    // lock is needed here even on a retry.
    if (event.type === 'checkout.session.completed') {
      for (let i = 0; i < itemCount; i++) {
        const redisKey = metadata[`redis_key_${i}`];
        if (!redisKey) continue; // untracked / made-to-order item, nothing to sync

        const stripeKey = metadata[`stripe_key_${i}`];
        const prodId = metadata[`prod_id_${i}`];

        const finalStock = await kv.get(redisKey);
        if (finalStock !== null) {
          const product = await stripe.products.retrieve(prodId);
          await stripe.products.update(prodId, {
            metadata: { ...product.metadata, [stripeKey]: finalStock.toString() },
          });
        }
      }
    }

    // CART ABANDONED / EXPIRED: release reserved stock back to Redis.
    // This is an INCREMENT, not a re-copy, so it is NOT naturally idempotent — running it twice
    // would inflate stock. Each line item gets its own one-time claim, independent of whether the
    // whole event ever gets marked processed, so a partial failure elsewhere in this same event
    // can't cause a double-release on retry.
    if (event.type === 'checkout.session.expired') {
      for (let i = 0; i < itemCount; i++) {
        const redisKey = metadata[`redis_key_${i}`];
        if (!redisKey) continue; // untracked / made-to-order item, nothing to release

        const releaseMarker = `released_${session.id}_${i}`;
        const claimed = await kv.set(releaseMarker, '1', { nx: true, ex: 86400 });
        if (!claimed) continue; // this specific item was already released on a prior attempt

        const qtyToReturn = parseInt(metadata[`qty_${i}`]);
        await kv.incrby(redisKey, qtyToReturn);
      }
    }

    // COMMIT: only mark the whole event as processed after every step above succeeded.
    await kv.set(eventKey, '1', { ex: 86400 });
  } catch (err) {
    // A transient failure here (Redis blip, Stripe API error) means we deliberately do NOT set
    // eventKey, so Stripe's automatic retry will safely pick up where things left off — the
    // per-item release markers ensure anything that already succeeded isn't repeated.
    console.error('Webhook processing failed, will retry on redelivery:', err);
    return res.status(500).json({ error: 'Processing failed, awaiting Stripe retry' });
  }

  res.status(200).json({ received: true });
}
