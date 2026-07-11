#!/usr/bin/env node
/**
 * generate-ad-manifest.js
 *
 * Melody is a static, client-side app with no backend — a browser can't
 * list a folder's contents on its own. So instead of hardcoding ad
 * filenames in JS (which the spec explicitly rules out), the actual list
 * of ad filenames lives in assets/audio/ad/manifest.json, and ad-manager.js
 * only ever reads THAT — no filename ever appears in application code.
 *
 * This script is what keeps the manifest in sync with the real folder.
 * Run it any time you add, remove, or rename a file in assets/audio/ad/:
 *
 *   node scripts/generate-ad-manifest.js
 *
 * (If Melody ever grows a real build step or backend, this is the first
 * thing to replace with an actual runtime directory listing endpoint.)
 */
const fs = require('fs');
const path = require('path');

const AD_DIR = path.join(__dirname, '..', 'assets', 'audio', 'ad');
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg'];

function main() {
  if (!fs.existsSync(AD_DIR)) {
    console.error(`Ad folder not found: ${AD_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(AD_DIR)
    .filter((f) => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort();

  const manifestPath = path.join(AD_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 2) + '\n');

  console.log(`Wrote ${files.length} ad file(s) to ${manifestPath}:`);
  files.forEach((f) => console.log(`  - ${f}`));
}

main();
