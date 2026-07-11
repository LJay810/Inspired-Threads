// Stripe hard-caps a Checkout Session's metadata at 50 total keys. The original design used
// 6 separate keys per distinct cart line item (Item_N, id_N, prod_id_N, stripe_key_N,
// redis_key_N, qty_N) -- meaning any cart with more than ~7 distinct items overflowed that
// cap outright and failed checkout with a real Stripe error. A live customer hit exactly
// this during a livestream.
//
// Fix: pack everything about one line item into a SINGLE JSON-encoded key instead of six.
// Same total information, 1 key per item instead of 6 -- raises the ceiling from ~7 distinct
// items to 40+. checkout.js (the writer) and webhook.js (the reader) both import this so the
// packed format can't drift out of sync between them.

function packCartItemMetadata(item, product, stripeMetaKey, redisKey, hasStockLimit) {
  return JSON.stringify({
    n: (item.name || '').slice(0, 60), // trimmed -- only used for Stripe Dashboard readability
    pid: item.priceId,
    prod: product.id,
    sk: stripeMetaKey,
    rk: hasStockLimit ? redisKey : '', // empty = untracked, webhook/checkout both skip it
    q: item.quantity,
  });
}

function unpackCartItemMetadata(metadata, index) {
  const raw = metadata[`item_${index}`];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      name: parsed.n,
      priceId: parsed.pid,
      prodId: parsed.prod,
      stripeMetaKey: parsed.sk,
      redisKey: parsed.rk,
      qty: parsed.q,
    };
  } catch (err) {
    return null;
  }
}

module.exports = { packCartItemMetadata, unpackCartItemMetadata };