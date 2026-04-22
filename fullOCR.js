import Tesseract from 'tesseract.js';
import preprocessImage from './preprocess.js';

// Fungsi untuk melakukan OCR secara penuh pada slip
async function fullOCR(imagePath) {
  try {
    // Pra-proses imej untuk meningkatkan kebolehbacaan (menggunakan threshold dan resize jika perlu)
    const processedPath = imagePath.replace(/\.jpg$/i, '_processed.jpg');
    await preprocessImage(imagePath, processedPath);
    
    // Jalankan OCR pada imej yang telah dipra-proses
    const result = await Tesseract.recognize(processedPath, 'eng', {
      user_defined_dpi: '300'
    });
    
    // Kembalikan semua teks yang dihasilkan oleh OCR
    return result.data.text;
  } catch (err) {
    console.error('❌ OCR Error:', err);
    throw err;
  }
}

// Contoh penggunaan
const filePath = 'slip-rhb.jpg'; // Pastikan fail terletak di folder yang sama
fullOCR(filePath)
  .then(text => {
    console.log('OCR Full Text:\n', text);
  })
  .catch(err => {
    console.error('Ralat semasa full OCR:', err);
  });
