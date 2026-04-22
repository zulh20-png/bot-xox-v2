// testPdfToImage.js
import convertPdfToImage from './pdfToImage.js';

async function testConversion() {
  // Gunakan path relatif kepada fail PDF di folder slips
  const pdfPath = 'slips/BAUCER PEMBAYARAN 2024.pdf';
  // Output folder, contohnya juga "slips"
  const outputDir = 'slips';
  const pageNumber = 1;

  try {
    const imagePath = await convertPdfToImage(pdfPath, outputDir, pageNumber);
    console.log('Imej dihasilkan di:', imagePath);
  } catch (err) {
    console.error('Ralat semasa penukaran PDF:', err.message);
  }
}

testConversion();
