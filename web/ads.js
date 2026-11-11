// Fake ad copy used to disguise messages in private mode. All brands are fictional.
// Generated from a seed so a given message always gets the same disguise.

const BRANDS = [
  'Brightline Supply', 'Northfold Outdoor', 'Kettle & Pine', 'Lumen Optics', 'Harbor Linen',
  'Copperleaf Tea', 'Fieldwork Studio', 'Atlas Carry Co.', 'Quiet Hour Audio', 'Meridian Cycles',
  'Saltmarsh Ceramics', 'Oakridge Paper', 'Tidewater Coffee', 'Pinecrest Bedding', 'Glasshouse Plants',
];
const OFFERS = [
  'Save 20% on', 'New season:', 'Members get early access to', 'Free shipping on', 'Up to 40% off',
  'Just restocked:', 'Limited run:', 'Two for one on', 'Introducing', 'This week only:',
];
const PRODUCTS = [
  'hand-stitched notebooks', 'merino travel layers', 'small-batch loose leaf tea', 'noise-cancelling headphones',
  'linen bedding sets', 'commuter bike lights', 'stoneware mugs', 'weatherproof daypacks', 'reading lamps',
  'single-origin coffee', 'indoor plant kits', 'fountain pens', 'cast iron skillets', 'wool throw blankets',
];
const HOOKS = [
  'Made to last, built to be repaired.', 'Ships in 2 days.', 'Rated 4.8 by 12,000 customers.',
  'Easy 60-day returns.', 'Designed in small batches.', 'See why readers love it.', 'While stocks last.',
  'Carbon-neutral delivery.', 'Gift wrapping included.',
];
const CTAS = ['Shop now', 'Learn more', 'Get the offer', 'See the range', 'Browse now'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fakeAd(seed) {
  const r = rng(Number(seed) * 2654435761);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  return {
    brand: pick(BRANDS),
    copy: `${pick(OFFERS)} ${pick(PRODUCTS)}. ${pick(HOOKS)}`,
    cta: pick(CTAS),
  };
}

/** Stable hue (0-359) for a brand/author name, used for the logo tile. */
export function hueOf(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
