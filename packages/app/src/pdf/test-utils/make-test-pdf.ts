/**
 * A minimal, hand-assembled PDF with one text-bearing page per requested page.
 * Real PDFs are the only honest input for a pdf.js test, and a fixture file
 * would have to be a committed binary — this builds the bytes instead.
 */
export function makeTestPdf({ pages = 1 }: { pages?: number } = {}): Uint8Array {
  const pageObjectStart = 3;
  const fontObjectNumber = pageObjectStart + pages * 2;

  const pageRefs: string[] = [];
  const pageObjects: string[] = [];
  const contentObjects: string[] = [];
  for (let index = 0; index < pages; index += 1) {
    const pageNumber = pageObjectStart + index;
    const contentNumber = pageObjectStart + pages + index;
    pageRefs.push(`${pageNumber} 0 R`);
    pageObjects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
    const stream = `BT /F1 24 Tf 20 100 Td (Page ${index + 1}) Tj ET`;
    contentObjects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages} >>`,
    ...pageObjects,
    ...contentObjects,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}
