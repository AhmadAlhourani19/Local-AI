export async function readAnyTextFromFile(file) {
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return await readPdfAllText(file);
  return await file.text(); 
}

async function readPdfAllText(file) {
  const pdfjs = await import('pdfjs-dist/build/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ');
    out += `\n[SEITE ${i}]\n${text}`;
  }
  return out.trim();
}
