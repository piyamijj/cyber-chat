import { NextRequest } from "next/server";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 15000;

const PLAIN_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  // Code, config, and web/markup formats — all plain text, read the
  // same way as .txt/.md, no special parser needed.
  ".html",
  ".htm",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".py",
  ".xml",
  ".yaml",
  ".yml",
  ".sh",
  ".sql",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".go",
  ".rb",
  ".php",
  ".rs",
  ".swift",
  ".kt",
  ".env",
  ".ini",
  ".toml",
];
const SPREADSHEET_EXTENSIONS = [".xlsx", ".xls"];

function getExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf(".");
  return idx >= 0 ? lower.slice(idx) : "";
}

function truncateText(text: string): string {
  if (text.length > MAX_TEXT_LENGTH) {
    return `${text.slice(0, MAX_TEXT_LENGTH)}\n\n[Content truncated]`;
  }
  return text;
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles: { index: number; path: string }[] = [];
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) {
      slideFiles.push({ index: parseInt(match[1], 10), path: relativePath });
    }
  });

  slideFiles.sort((a, b) => a.index - b.index);

  const slideTexts: string[] = [];
  for (const slideFile of slideFiles) {
    const entry = zip.file(slideFile.path);
    if (!entry) continue;
    const xml = await entry.async("text");
    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
    const texts = matches.map((m) => {
      const inner = m.match(/<a:t[^>]*>([^<]*)<\/a:t>/);
      return inner ? inner[1] : "";
    });
    const slideText = texts.join(" ").trim();
    slideTexts.push(`\n\n--- Slide ${slideFile.index} ---\n\n${slideText}`);
  }

  return slideTexts.join("").trim();
}

export async function POST(req: NextRequest) {
  let formData: FormData;

  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return new Response(
      JSON.stringify({ error: "No file provided." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return new Response(
      JSON.stringify({ error: "File too large. Maximum size is 8MB." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const extension = getExtension(file.name || "");

  const isSupported =
    PLAIN_TEXT_EXTENSIONS.includes(extension) ||
    SPREADSHEET_EXTENSIONS.includes(extension) ||
    extension === ".pdf" ||
    extension === ".docx" ||
    extension === ".pptx";

  if (!isSupported) {
    return new Response(
      JSON.stringify({
        error:
          "Desteklenmeyen dosya türü. Desteklenenler: .txt, .md, .csv, .json, .log, .pdf, .docx, .xlsx, .xls, .pptx, ve yaygın kod/config dosyaları (.html, .js, .ts, .css, .py, .xml, .yaml, .sh, .sql, .java, .c, .cpp, .go, .rb, .php, .rs, .swift, .kt, .env, .ini, .toml).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    let extractedText = "";

    if (PLAIN_TEXT_EXTENSIONS.includes(extension)) {
      const arrayBuffer = await file.arrayBuffer();
      extractedText = new TextDecoder("utf-8").decode(arrayBuffer);
    } else if (extension === ".pdf") {
      // Import the internal lib file directly, NOT the package's
      // top-level index.js: pdf-parse's index.js has a debug-mode
      // guard that misfires under Next.js/Vercel bundling and tries
      // to read a nonexistent test fixture (test/data/05-versions-
      // space.pdf), throwing ENOENT on every real request. Bypassing
      // index.js avoids that guard entirely.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await pdfParse(buffer);
      extractedText = result.text || "";
    } else if (extension === ".docx") {
      const mammoth = await import("mammoth");
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value || "";
    } else if (SPREADSHEET_EXTENSIONS.includes(extension)) {
      const XLSX = await import("xlsx");
      const buffer = Buffer.from(await file.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: "buffer" });

      const sheetTexts = workbook.SheetNames.map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(worksheet);
        return `## Sheet: ${sheetName}\n${csv}`;
      });

      extractedText = sheetTexts.join("\n\n");
    } else if (extension === ".pptx") {
      const buffer = Buffer.from(await file.arrayBuffer());
      extractedText = await extractPptxText(buffer);
    }

    const truncated = truncateText(extractedText);

    return new Response(
      JSON.stringify({ text: truncated, fileName: file.name }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to extract file content." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}