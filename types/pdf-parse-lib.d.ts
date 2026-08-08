declare module "pdf-parse/lib/pdf-parse.js" {
  interface PDFParseResult {
    text: string;
    numpages?: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    version?: string;
  }

  type PDFParse = (
    dataBuffer: Buffer,
    options?: Record<string, unknown>
  ) => Promise<PDFParseResult>;

  const pdfParse: PDFParse;
  export default pdfParse;
}