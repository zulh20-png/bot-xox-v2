import { fromPath } from "pdf2pic";

async function convertPdfToImage(pdfPath, outputDir, pageNumber = 1) {
  const options = {
    density: 300,             // DPI yang mencukupi untuk OCR, lebih ringan
    saveFilename: `page_${pageNumber}`,
    savePath: outputDir,
    format: "jpg",            // Tukar ke format "jpg" untuk konsistensi
    width: 1600,              // Lebar imej
    height: 2200              // Tinggi imej
  };

  const storeAsImage = fromPath(pdfPath, options);
  const result = await storeAsImage(pageNumber);
  console.log(`✅ Halaman ${pageNumber} daripada PDF ditukar ke imej: ${result.path}`);
  return result.path; // Mengembalikan path imej yang dihasilkan
}

export default convertPdfToImage;
