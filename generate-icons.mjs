import sharp from 'sharp';
import fs from 'node:fs';

const input = '/home/lenny/.gemini/antigravity-cli/brain/38d32e38-55b6-40bb-9cca-e34523d316b3/.user_uploaded/uploaded_media_1790102752651.png';

async function generate() {
  const image = sharp(input);
  const metadata = await image.metadata();
  const size = Math.max(metadata.width, metadata.height);

  // Pad to square
  const squareImg = image.resize(size, size, {
    fit: 'contain',
    background: { r: 245, g: 245, b: 245, alpha: 1 } // generic light grey
  });

  // Generate PNGs
  await squareImg.clone().resize(16, 16).toFile('public/favicon-16x16.png');
  await squareImg.clone().resize(32, 32).toFile('public/favicon-32x32.png');
  await squareImg.clone().resize(180, 180).toFile('public/apple-touch-icon.png');
  await squareImg.clone().resize(192, 192).toFile('public/icon-192.png');
  await squareImg.clone().resize(512, 512).toFile('public/icon-512.png');
  
  // For maskable, usually we want some padding so it doesn't get cut off in a circle
  await squareImg.clone().resize(512, 512, { fit: 'contain', background: '#F5F5F5' }).toFile('public/icon-512-maskable.png');
  
  console.log('Icons generated successfully.');
}

generate().catch(console.error);
