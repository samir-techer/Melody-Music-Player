/**
 * image-resize.js
 * Client-side image downscale/compress, so an uploaded profile photo (which
 * could be several MB straight off a phone camera) becomes a small square
 * JPEG data URL before it's ever stored — safe to keep in a Firestore
 * document field (1MB/field limit) and fast to load everywhere it's shown.
 */

/**
 * @param {File} file - an image file, e.g. from <input type="file">
 * @param {{ maxSize?: number, quality?: number }} [options]
 * @returns {Promise<string>} a "data:image/jpeg;base64,..." data URL,
 *   center-cropped to a square and downscaled to at most maxSize×maxSize.
 */
export function resizeImageFile(file, { maxSize = 256, quality = 0.85 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('That file doesn\u2019t look like an image.'));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        // Center-crop to a square first, so the final avatar isn't stretched.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;

        const canvas = document.createElement('canvas');
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);

        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Couldn\u2019t read that image.'));
    };

    img.src = objectUrl;
  });
}
