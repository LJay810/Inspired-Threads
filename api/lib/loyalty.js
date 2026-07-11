// Shared loyalty-program logic: XP formula, tiers, perks, and the badges that can be
// evaluated purely from order data (no referral/review/founding-member system exists yet,
// so those badges stay manual/future -- see README-LOYALTY.md).
//
// IMPORTANT: index.html has NO build step and can't `require()` this file -- it keeps its
// own copies of TIERS and PERKS inline (search "TIER / XP / BADGES" in index.html). If you
// change the numbers here, change them there too.

const TIERS = [
  { name: 'VIP',    minXp: 2000 },
  { name: 'Gold',   minXp: 500 },
  { name: 'Silver', minXp: 100 },
  { name: 'Bronze', minXp: 0 },
];

// Perks are cumulative -- Gold members also have every Silver/Bronze perk, etc.
// freeShippingMin: order subtotal (in dollars) at/above which shipping is free. null = no perk.
// standingDiscountPct: automatically applied at checkout, every order.
// birthdayDiscountPct: the % on that tier's once-a-year birthday promo code.
// vipShippingCredit: a flat dollar amount knocked off the shipping fee, capped at N uses/month
// (kept separate from freeShippingMin/standingDiscountPct because Stripe Checkout Sessions only
// allow ONE `discounts` coupon per session -- this is applied as a direct shipping-fee reduction
// instead of a second coupon, so it never conflicts with the standing discount).
const PERKS = {
  Bronze: { birthdayDiscountPct: 10, standingDiscountPct: 0, freeShippingMin: null, vipShippingCredit: null, stickerPack: false },
  Silver: { birthdayDiscountPct: 15, standingDiscountPct: 0, freeShippingMin: 75,   vipShippingCredit: null, stickerPack: true },
  Gold:   { birthdayDiscountPct: 20, standingDiscountPct: 5, freeShippingMin: 60,   vipShippingCredit: null, stickerPack: true },
  VIP:    { birthdayDiscountPct: 25, standingDiscountPct: 10, freeShippingMin: null,
            vipShippingCredit: { amount: 3.50, usesPerMonth: 2 }, stickerPack: true },
};

// Applies to every tier equally, so it lives outside PERKS rather than repeated on each tier.
const ANNIVERSARY_XP_MULTIPLIER = 2;

// Whether at least a full year has passed since signup. Used both standalone (nothing else
// needs it, since isAnniversaryDay below already calls it internally) and exported for
// clarity/testability.
function hasCompletedFullYear(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  return (now.getTime() - new Date(createdAtISO).getTime()) >= oneYearMs;
}

// True ONLY on the exact calendar day matching signup, AND only once a genuine full year has
// actually passed -- e.g. signed up March 12 2025 -> only March 12 2026 (and every March 12
// after that), never any other day in March, and never in the first 12 months of the account.
// Previously this only checked "same month, any year" with no year requirement at all --
// which meant literally every new signup got double XP immediately on their first order, as
// an accidental "welcome bonus" nobody actually decided to build. Fixed by requiring both
// conditions together, not as two separate checks.
function isAnniversaryDay(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  const created = new Date(createdAtISO);
  return created.getUTCMonth() === now.getUTCMonth()
    && created.getUTCDate() === now.getUTCDate()
    && hasCompletedFullYear(createdAtISO, now);
}

// XP now tracks actual revenue, not item count -- the old "25 + 10/unit" formula let a
// handful of $2 DTFs earn more than half of Silver in a single $6 order, which doesn't
// reflect what the shopper actually spent. Reworked around dollars spent instead:
//
//   XP = (flat completion bonus) + (XP_PER_DOLLAR x dollars spent), doubled in an
//   anniversary month, then capped so one giant order can't vault someone straight to VIP.
//
// At these numbers, reaching each tier through NORMAL repeat orders looks roughly like:
//   Silver (100 XP)  ~ $45-50 lifetime spent
//   Gold   (500 XP)  ~ $245-250 lifetime spent
//   VIP    (2000 XP) ~ $995-1000 lifetime spent
// (assuming typical ~$6-10 orders; heavier one-time orders take longer per dollar because
// of the per-order cap below, which is the point -- tiers should reward being a repeat
// customer, not one big purchase.)
const XP_PER_DOLLAR = 2;
const ORDER_COMPLETION_BONUS = 5;
const ORDER_XP_CAP = 150; // no single order can earn more than this, anniversary bonus included

function xpForOrder(amountSpentDollars, multiplier = 1) {
  const raw = ORDER_COMPLETION_BONUS + XP_PER_DOLLAR * Math.max(0, amountSpentDollars);
  return Math.min(Math.round(raw * multiplier), ORDER_XP_CAP);
}

function tierForXp(xp) {
  return TIERS.find(t => xp >= t.minXp).name;
}

function perksForTier(tierName) {
  return PERKS[tierName] || PERKS.Bronze;
}

// Badges this backend can decide on its own, using only data the webhook already has
// after a completed order: how many orders total, lifetime spend, this order's size, and
// (now that we look it up for the anniversary XP bonus) whether this is their anniversary
// month a full year or more after signing up.
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
  TIERS, PERKS, ANNIVERSARY_XP_MULTIPLIER,
  xpForOrder, tierForXp, perksForTier, evaluateOrderBadges,
  isAnniversaryDay, hasCompletedFullYear,
};