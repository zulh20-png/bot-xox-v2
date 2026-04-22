// preprocess.js
import fs from 'fs';
import { Jimp } from 'jimp';

/**
 * Fungsi preprocessImage menerima param "pipeline" untuk menentukan
 * kaedah pra-proses yang berbeza (standard, grayscaleThreshold, inverse, dsb.)
 *
 * @param {string} inputPath - Lokasi imej input asal
 * @param {string} outputPath - Lokasi untuk simpan imej yang telah diproses
 * @param {string} pipeline - Jenis pipeline (cth: 'standard', 'grayscaleThreshold', 'mbb', dll.)
 */
async function preprocessImage(inputPath, outputPath, pipeline = 'standard') {
  try {
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error(`Fail input tidak ditemui: ${inputPath || '(tiada path)'}`);
    }
    const stat = fs.statSync(inputPath);
    const t0 = Date.now();
    const image = await Jimp.read(inputPath);
    console.log(`[preprocess] ${pipeline} mula -> ${inputPath} (${stat.size} bytes, asal ${image.bitmap.width}x${image.bitmap.height})`);

    // 1) Pastikan resolusi minimum (API baharu Jimp gunakan objek, bukan Jimp.AUTO)
    if (image.bitmap.width < 800) {
      console.log(`[preprocess] ${pipeline} resize ke lebar 800`);
      image.resize({ w: 800 });
    }

    switch (pipeline) {
      case 'grayscaleThreshold':
        // Grayscale + threshold
        image.greyscale();
        console.log(`[preprocess] ${pipeline} grayscale`);
        image.threshold({ max: 150 });
        break;

      case 'inverse':
        // Inverse (negative)
        image.invert();
        break;

      case 'mbb':
        // Pipeline khas (contoh untuk slip Maybank)
        image.greyscale();
        image.convolute([
          [0, -1, 0],
          [-1, 6, -1],
          [0, -1, 0]
        ]);
        console.log(`[preprocess] ${pipeline} convolute mbb`);
        image.threshold({ max: 180 });
        break;

      default:
        // Pipeline standard - penajaman biasa
        image.convolute([
          [0, -1, 0],
          [-1, 5, -1],
          [0, -1, 0]
        ]);
        console.log(`[preprocess] ${pipeline} convolute standard`);
        break;
    }

    // 2) Simpan imej hasil pra-proses (wrap callback untuk Promise)
    console.log(`[preprocess] ${pipeline} tulis fail -> ${outputPath}`);
    if (typeof image.writeAsync === 'function') {
      await image.writeAsync(outputPath);
    } else {
      await new Promise((resolve, reject) => {
        image.write(outputPath, (err) => (err ? reject(err) : resolve()));
      });
    }
    console.log(`[preprocess] ${pipeline} siap -> ${outputPath} (${image.bitmap.width}x${image.bitmap.height}) dalam ${(Date.now()-t0)/1000}s`);
  } catch (err) {
    console.error('Ralat pre-processing imej:', err.message);
    throw err;
  }
}

export default preprocessImage;
