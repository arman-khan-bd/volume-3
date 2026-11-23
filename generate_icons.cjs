const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src-tauri', 'icons');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Generate a valid 16x16 ICO file containing uncompressed BMP
function createIco() {
  const width = 16;
  const height = 16;
  const bpp = 32;
  const headerSize = 40;
  const pixelSize = width * height * 4;
  const maskRowSize = Math.ceil(width / 32) * 4; // 4 bytes per row
  const maskSize = maskRowSize * height;
  const imageSize = headerSize + pixelSize + maskSize;
  const totalSize = 22 + imageSize;

  const buf = Buffer.alloc(totalSize);

  // ICONDIR
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // type 1 = icon
  buf.writeUInt16LE(1, 4); // count 1

  // ICONDIRENTRY
  buf.writeUInt8(width, 6);
  buf.writeUInt8(height, 7);
  buf.writeUInt8(0, 8); // color count
  buf.writeUInt8(0, 9); // reserved
  buf.writeUInt16LE(1, 10); // planes
  buf.writeUInt16LE(bpp, 12); // bit count
  buf.writeUInt32LE(imageSize, 14); // bytes in res
  buf.writeUInt32LE(22, 18); // image offset

  // BITMAPINFOHEADER
  let offset = 22;
  buf.writeUInt32LE(40, offset); // biSize
  buf.writeInt32LE(width, offset + 4); // biWidth
  buf.writeInt32LE(height * 2, offset + 8); // biHeight (doubled for ICO mask)
  buf.writeUInt16LE(1, offset + 12); // biPlanes
  buf.writeUInt16LE(bpp, offset + 14); // biBitCount
  buf.writeUInt32LE(0, offset + 16); // biCompression (BI_RGB)
  buf.writeUInt32LE(pixelSize + maskSize, offset + 20); // biSizeImage
  buf.writeInt32LE(0, offset + 24); // biXPelsPerMeter
  buf.writeInt32LE(0, offset + 28); // biYPelsPerMeter
  buf.writeUInt32LE(0, offset + 32); // biClrUsed
  buf.writeUInt32LE(0, offset + 36); // biClrImportant

  offset += 40;

  // Pixels (BGRA, bottom-up)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Draw blue circle/square
      const isBorder = (x === 0 || x === width - 1 || y === 0 || y === height - 1);
      buf.writeUInt8(185, offset);     // B
      buf.writeUInt8(128, offset + 1); // G
      buf.writeUInt8(41, offset + 2);  // R
      buf.writeUInt8(isBorder ? 255 : 200, offset + 3); // A
      offset += 4;
    }
  }

  // 1-bit AND mask (all zeros = fully opaque/visible according to alpha channel)
  for (let i = 0; i < maskSize; i++) {
    buf.writeUInt8(0, offset + i);
  }

  return buf;
}

fs.writeFileSync(path.join(dir, 'icon.ico'), createIco());

// Write a minimal valid 1x1 PNG for placeholder png icons
// Valid 1x1 transparent PNG data:
const png1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

fs.writeFileSync(path.join(dir, '32x32.png'), png1x1);
fs.writeFileSync(path.join(dir, '128x128.png'), png1x1);
fs.writeFileSync(path.join(dir, '128x128@2x.png'), png1x1);
fs.writeFileSync(path.join(dir, 'icon.png'), png1x1);
fs.writeFileSync(path.join(dir, 'icon.icns'), png1x1);

console.log('Icons written successfully to', dir);
