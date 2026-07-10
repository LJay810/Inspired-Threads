const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const { createClient } = require('@supabase/supabase-js');
const { xpForOrder, tierForXp, evaluateOrderBadges, isAnniversaryMonth, hasCompletedFullYear, ANNIVERSARY_XP_MULTIPLIER } = require('./lib/loyalty');
const { notifyRestock } = require('./lib/notify');
const { unpackCartItemMetadata } = require('./lib/cart-metadata');

// Service-role client: bypasses RLS, used only here and in cron-birthday-coupons.js to write
// loyalty fields the shopper's own browser session is never allowed to touch directly.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

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
        const itemData = unpackCartItemMetadata(metadata, i);
        if (!itemData || !itemData.redisKey) continue; // untracked / made-to-order item, nothing to sync

        const finalStock = await kv.get(itemData.redisKey);
        if (finalStock !== null) {
          const product = await stripe.products.retrieve(itemData.prodId);
          await stripe.products.update(itemData.prodId, {
            metadata: { ...product.metadata, [itemData.stripeMetaKey]: finalStock.toString() },
          });
        }
      }

      // PURCHASE LEDGER: record every item this order contained (unlike the stock-sync loop
      // above, this runs for ALL items -- including untracked/made-to-order ones with no
      // redisKey -- since it's what verified-purchase reviews check against). Logged-out/guest
      // checkouts have no supabase_user_id, so nothing gets recorded for them -- see the
      // KNOWN LIMITATION note in referral_reviews_schema.sql.
      if (metadata.supabase_user_id && supabaseAdmin) {
        const purchaseRows = [];
        for (let i = 0; i < itemCount; i++) {
          const itemData = unpackCartItemMetadata(metadata, i);
          if (!itemData || !itemData.prodId) continue;
          purchaseRows.push({
            user_id: metadata.supabase_user_id,
            product_id: itemData.prodId,
            session_id: session.id,
          });
        }
        if (purchaseRows.length > 0) {
          // ignoreDuplicates handles a Stripe retry re-running this whole handler: the
          // (user_id, product_id, session_id) unique constraint makes re-inserting a no-op
          // rather than an error or a duplicate row.
          const { error: purchaseErr } = await supabaseAdmin
            .from('purchases')
            .upsert(purchaseRows, { onConflict: 'user_id,product_id,session_id', ignoreDuplicates: true });
          if (purchaseErr) throw purchaseErr;
        }
      }

      // LOYALTY: award XP/tier/badges to logged-in shoppers. This is an INCREMENT against
      // Supabase (not a re-copy), so — same reasoning as the expired-session release below —
      // it is NOT naturally idempotent and needs its own one-time claim independent of the
      // whole-event eventKey, in case Stripe redelivers this event after a failure elsewhere
      // in this same handler.
      const supabaseUserId = metadata.supabase_user_id;
      if (supabaseUserId && supabaseAdmin) {
        const loyaltyMarker = `loyalty_awarded_${session.id}`;
        const claimed = await kv.set(loyaltyMarker, '1', { nx: true, ex: 86400 * 2 });

        if (claimed) {
          let orderUnits = 0;
          for (let i = 0; i < itemCount; i++) {
            const itemData = unpackCartItemMetadata(metadata, i);
            orderUnits += itemData ? (parseInt(itemData.qty, 10) || 0) : 0;
          }

          // Anniversary perk: double XP during the shopper's signup month, every year.
          // A lookup failure here should never block the (still-valid) base XP award.
          let xpMultiplier = 1;
          let isAnniversaryYear = false;
          try {
            const { data: userData } = await supabaseAdmin.auth.admin.getUserById(supabaseUserId);
            const createdAt = userData && userData.user && userData.user.created_at;
            if (createdAt && isAnniversaryMonth(createdAt)) {
              xpMultiplier = ANNIVERSARY_XP_MULTIPLIER;
              isAnniversaryYear = hasCompletedFullYear(createdAt);
            }
          } catch (err) {
            console.warn('Could not check anniversary bonus, awarding standard XP:', err.message);
          }

          const amountSpent = (session.amount_total || 0) / 100;
          const orderXp = xpForOrder(amountSpent, xpMultiplier);

          const { data: awarded, error: rpcErr } = await supabaseAdmin.rpc('award_loyalty', {
            p_user_id: supabaseUserId,
            p_xp_delta: orderXp,
            p_spent_delta: amountSpent,
            p_order_items: orderUnits,
          });
          if (rpcErr) throw rpcErr;

          const totals = Array.isArray(awarded) ? awarded[0] : awarded;
          const tierName = tierForXp(totals.xp);
          const newBadges = evaluateOrderBadges({
            orderCount: totals.order_count,
            totalSpent: totals.total_spent,
            orderUnits,
            tierName,
            isAnniversaryYear,
          });

          if (newBadges.length > 0) {
            const { error: badgeErr } = await supabaseAdmin.rpc('add_badges', {
              p_user_id: supabaseUserId,
              p_new_badges: newBadges,
            });
            if (badgeErr) throw badgeErr;
          }

          // REFERRAL PAYOUT: if this was the referee's first-ever order, reward whoever
          // referred them. Gated on order_count === 1 (exact match, same idiom as the
          // first_order badge) -- since order_count only increments and can equal 1 exactly
          // once per account, this can't double-grant even across a Stripe retry of a
          // DIFFERENT order for the same person (only fires the one time it's genuinely true).
          if (totals.order_count === 1) {
            const { data: refereeProfile } = await supabaseAdmin
              .from('profiles')
              .select('referred_by')
              .eq('id', supabaseUserId)
              .single();

            if (refereeProfile && refereeProfile.referred_by) {
              const { data: newReferralCount, error: referralErr } = await supabaseAdmin.rpc('grant_referral_reward', {
                p_referrer_id: refereeProfile.referred_by,
              });
              if (referralErr) throw referralErr;

              if (newReferralCount === 1) {
                await supabaseAdmin.rpc('add_badges', {
                  p_user_id: refereeProfile.referred_by,
                  p_new_badges: ['referral'],
                });
              }
            }
          }
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
        const itemData = unpackCartItemMetadata(metadata, i);
        if (!itemData || !itemData.redisKey) continue; // untracked / made-to-order item, nothing to release

        const releaseMarker = `released_${session.id}_${i}`;
        const claimed = await kv.set(releaseMarker, '1', { nx: true, ex: 86400 });
        if (!claimed) continue; // this specific item was already released on a prior attempt

        const qtyToReturn = parseInt(itemData.qty, 10);
        const newStockLevel = await kv.incrby(itemData.redisKey, qtyToReturn);

        // A genuine restock is specifically the 0 (or below) -> positive crossing -- releasing
        // an abandoned cart that DIDN'T sell out the last unit just returns stock to whatever
        // positive number it already was, which nobody needed alerting about.
        const previousStockLevel = newStockLevel - qtyToReturn;
        if (previousStockLevel <= 0 && newStockLevel > 0) {
          try {
            const product = await stripe.products.retrieve(itemData.prodId);
            const imageUrl = product.images && product.images.length > 0 ? product.images[0] : null;
            await notifyRestock(supabaseAdmin, itemData.prodId, product.name, imageUrl);
          } catch (err) {
            // Never let a notification failure block the actual stock release.
            console.error('Restock notification failed:', err.message);
          }
        }
      }

      // Give back a reserved-but-unused VIP monthly shipping credit, same one-time-claim
      // reasoning as the stock release just above.
      if (metadata.vip_credit_used === 'true' && metadata.supabase_user_id && supabaseAdmin) {
        const creditReleaseMarker = `vip_credit_released_${session.id}`;
        const claimed = await kv.set(creditReleaseMarker, '1', { nx: true, ex: 86400 });
        if (claimed) {
          const { error: releaseErr } = await supabaseAdmin.rpc('release_vip_shipping_credit', {
            p_user_id: metadata.supabase_user_id,
            p_year_month: metadata.vip_credit_month,
          });
          if (releaseErr) throw releaseErr;
        }
      }

      // Same idea for a reserved-but-unused referral discount (either the referrer's queued
      // reward, or the referee's one-time first-order discount -- checkout.js only ever
      // reserves one or the other per session, tagged by referral_discount_type).
      if (metadata.referral_discount_type && metadata.supabase_user_id && supabaseAdmin) {
        const referralReleaseMarker = `referral_released_${session.id}`;
        const claimed = await kv.set(referralReleaseMarker, '1', { nx: true, ex: 86400 });
        if (claimed) {
          const rpcName = metadata.referral_discount_type === 'reward'
            ? 'release_referral_reward'
            : 'release_referee_discount';
          const { error: releaseErr } = await supabaseAdmin.rpc(rpcName, { p_user_id: metadata.supabase_user_id });
          if (releaseErr) throw releaseErr;
        }
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