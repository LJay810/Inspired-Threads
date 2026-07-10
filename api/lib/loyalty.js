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

// True during the calendar month matching the shopper's signup month (every year, including
// their first) -- e.g. signed up March 12 2024 -> every March, XP is doubled.
function isAnniversaryMonth(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  return new Date(createdAtISO).getUTCMonth() === now.getUTCMonth();
}

// Whether at least a full year has passed since signup -- used to gate the 'anniversary'
// badge specifically (as opposed to the XP bonus, which applies every anniversary month
// including the shopper's very first).
function hasCompletedFullYear(createdAtISO, now = new Date()) {
  if (!createdAtISO) return false;
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  return (now.getTime() - new Date(createdAtISO).getTime()) >= oneYearMs;
}

// XP = a flat base per completed order, plus a per-unit amount so bigger carts earn more.
// "Units" means total item quantity across the order, not distinct line items.
const ORDER_XP_BASE = 25;
const ITEM_XP_PER_UNIT = 10;

function xpForOrder(totalUnits, multiplier = 1) {
  return Math.round((ORDER_XP_BASE + ITEM_XP_PER_UNIT * Math.max(0, totalUnits)) * multiplier);
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
  isAnniversaryMonth, hasCompletedFullYear,
};