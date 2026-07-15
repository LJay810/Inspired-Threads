// Shared loyalty-program logic: tiers (gated on real lifetime dollars spent -- no XP/points
// abstraction), perks, and the badges that can be evaluated purely from order data (no
// referral/review/founding-member system exists yet, so those badges stay manual/future).
//
// IMPORTANT: index.html has NO build step and can't `require()` this file -- it keeps its
// own copies of TIERS and PERKS inline (search "TIER / SPEND / BADGES" in index.html). If you
// change the numbers here, change them there too.

// Ordered highest -> lowest so tierForSpend/tierRank can do a simple linear scan.
const TIERS = [
  { name: 'VIP',          minSpend: 2000 },
  { name: 'Gold',         minSpend: 1200 },
  { name: 'Silver',       minSpend: 500 },
  { name: 'Bronze',       minSpend: 100 },
  { name: 'Crew Member',  minSpend: 0 },
];

// Perks are cumulative -- Gold members also have every Silver/Bronze/Crew Member perk, etc.
// freeShippingMin: order subtotal (in dollars) at/above which shipping is free. null = no perk.
// standingDiscountPct: automatically applied at checkout, every order.
// birthdayDiscountPct: the % on that tier's once-a-year birthday promo code.
// vipShippingCredit: a flat dollar amount knocked off the shipping fee, capped at N uses/month
// (kept separate from freeShippingMin/standingDiscountPct because Stripe Checkout Sessions only
// allow ONE `discounts` coupon per session -- this is applied as a direct shipping-fee reduction
// instead of a second coupon, so it never conflicts with the standing discount).
const PERKS = {
  'Crew Member': { birthdayDiscountPct: 10, standingDiscountPct: 0, freeShippingMin: null, vipShippingCredit: null, freeGift: false },
  Bronze:        { birthdayDiscountPct: 15, standingDiscountPct: 0, freeShippingMin: null, vipShippingCredit: null, freeGift: true },
  Silver:        { birthdayDiscountPct: 20, standingDiscountPct: 0, freeShippingMin: 75,   vipShippingCredit: null, freeGift: true },
  Gold:          { birthdayDiscountPct: 25, standingDiscountPct: 5, freeShippingMin: 60,   vipShippingCredit: null, freeGift: true },
  VIP:           { birthdayDiscountPct: 30, standingDiscountPct: 10, freeShippingMin: 60,
                    vipShippingCredit: { amount: 3.50, usesPerMonth: 2 }, freeGift: true },
};

// Whether at least a full year has passed since signup. Used standalone by the annual
// tier-reset block in api/cron-birthday-coupons.js and internally by isAnniversaryDay below.
function hasCompletedFullYear(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  return (now.getTime() - new Date(createdAtISO).getTime()) >= oneYearMs;
}

// True ONLY on the exact calendar day matching signup, AND only once a genuine full year has
// actually passed -- e.g. signed up March 12 2025 -> only March 12 2026 (and every March 12
// after that), never any other day in March, and never in the first 12 months of the account.
// Used by the annual-reset block in api/cron-birthday-coupons.js to fire each user's
// tier_spend reset on their own anniversary, and by evaluateOrderBadges below for the
// 'anniversary' badge.
function isAnniversaryDay(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  const created = new Date(createdAtISO);
  return created.getUTCMonth() === now.getUTCMonth()
    && created.getUTCDate() === now.getUTCDate()
    && hasCompletedFullYear(createdAtISO, now);
}

function tierForSpend(spend) {
  return TIERS.find(t => spend >= t.minSpend).name;
}

// Lower index = higher tier (TIERS is ordered highest -> lowest).
function tierRank(tierName) {
  const idx = TIERS.findIndex(t => t.name === tierName);
  return idx === -1 ? TIERS.length - 1 : idx;
}

// Effective tier is the HIGHER of the tier earned from real tier_spend and any grandfathered
// floor stamped onto the profile during the XP->dollars migration (see the one-time backfill
// in sql/loyalty_schema.sql). The floor only ever raises someone's displayed tier, never
// lowers it, and clears itself the next time this user's annual reset cron fires -- so it's a
// one-cycle safety net for people who were already at a tier when the system changed, not a
// standing exemption from the new dollar thresholds.
function effectiveTierName(tierSpend, grandfatheredTier) {
  const earned = tierForSpend(tierSpend);
  if (!grandfatheredTier) return earned;
  return tierRank(grandfatheredTier) < tierRank(earned) ? grandfatheredTier : earned;
}

function perksForTier(tierName) {
  return PERKS[tierName] || PERKS['Crew Member'];
}

// Badges this backend can decide on its own, using only data the webhook already has
// after a completed order: how many orders total, lifetime spend, this order's size, and
// whether this is their anniversary day a full year or more after signing up.
function evaluateOrderBadges({ orderCount, totalSpent, orderUnits, tierName, isAnniversaryYear }) {
  const earned = [];
  if (orderCount === 1) earned.push('first_order');
  if (orderCount === 5) earned.push('regular');
  if (orderUnits >= 3) earned.push('bundle_builder');
  if (totalSpent >= 300) earned.push('big_spender');
  if (tierName === 'VIP') earned.push('vip');
  if (isAnniversaryYear) earned.push('anniversary');
  return earned;
}

module.exports = {
  TIERS, PERKS,
  tierForSpend, tierRank, effectiveTierName, perksForTier, evaluateOrderBadges,
  isAnniversaryDay, hasCompletedFullYear,
};
