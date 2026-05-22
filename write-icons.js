// Decode the four icon PNGs (rendered via Chrome canvas from icon.svg)
// and write them to disk. Run once when the SVG changes:
//   node write-icons.js < icons.json
// where icons.json is the {"16": "data:image/png;base64,...", ...} blob.

const fs = require('fs');
const path = require('path');

const icons = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [size, value] of Object.entries(icons)) {
  // Accept both "data:image/png;base64,..." dataURLs and raw base64.
  const b64 = value.startsWith('data:') ? value.replace(/^data:image\/png;base64,/, '') : value;
  const buf = Buffer.from(b64, 'base64');
  const filename = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(filename, buf);
  console.log(`wrote ${filename} (${buf.length} bytes)`);
}
