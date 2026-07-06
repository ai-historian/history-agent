// Canary for downscaleToLimit (utils/crop-image.ts). Run from chronos/ after
// `npm run build`:  node scripts/downscale-canary.mjs
import sharp from "sharp";
import { downscaleToLimit } from "../dist/utils/crop-image.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const make = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 150 } } })
    .png()
    .toBuffer();

// Oversized image is capped on the long edge, aspect ratio preserved.
const big = await make(4000, 3000);
const capped = await downscaleToLimit(big, 2576);
const meta = await sharp(capped).metadata();
assert(meta.width === 2576, `long edge capped to 2576, got ${meta.width}`);
assert(meta.height === 1932, `aspect preserved (3000*2576/4000=1932), got ${meta.height}`);

// Portrait orientation: the LONG edge is capped, whichever axis it is.
const portrait = await make(1000, 4000);
const cappedPortrait = await downscaleToLimit(portrait, 2576);
const metaP = await sharp(cappedPortrait).metadata();
assert(metaP.height === 2576, `portrait long edge capped, got ${metaP.height}`);

// Under-cap image: returned byte-identical (no re-encode cost).
const small = await make(800, 600);
assert((await downscaleToLimit(small, 2576)) === small, "under-cap buffer returned unchanged");

// maxDim 0 disables entirely.
assert((await downscaleToLimit(big, 0)) === big, "maxDim 0 is a no-op");

console.log("downscale canary OK");
