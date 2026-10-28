// Port of internal/translator/common/file_data.go.
//
// Go consulted internal/misc.MimeTypes (a 700-entry table). The port carries the
// common document, image, audio, video and archive extensions; unknown extensions
// without an explicit fallback MIME type are rejected exactly as in Go.

export const mimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  js: "application/javascript",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  yaml: "text/yaml",
  yml: "text/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/x-wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  weba: "audio/webm",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
};

export interface NormalizedFileData {
  mimeType: string;
  data: string;
}

/**
 * Returns the MIME type and raw base64 payload for OpenAI file content, or
 * undefined when the input cannot be normalised (no payload, no resolvable MIME
 * type, or a data URL that is not base64).
 */
export function normalizeOpenAIFileData(filename: string, fallbackMIMEType: string, fileData: string): NormalizedFileData | undefined {
  if (fileData === "") return undefined;
  if (fallbackMIMEType === "") {
    const dot = filename.lastIndexOf(".");
    const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
    fallbackMIMEType = mimeTypes[ext] ?? "";
  }
  const dataURLPrefix = "data:";
  if (fileData.length < dataURLPrefix.length || fileData.slice(0, dataURLPrefix.length).toLowerCase() !== dataURLPrefix) {
    if (fallbackMIMEType === "") return undefined;
    return { mimeType: fallbackMIMEType, data: fileData };
  }
  const rest = fileData.slice(dataURLPrefix.length);
  const comma = rest.indexOf(",");
  if (comma < 0) return undefined;
  const metadata = rest.slice(0, comma);
  const payload = rest.slice(comma + 1);
  if (payload === "") return undefined;
  const fields = metadata.split(";");
  const mimeType = fields[0]!.trim();
  if (mimeType === "") return undefined;
  for (const field of fields.slice(1)) {
    if (field.trim().toLowerCase() === "base64") return { mimeType, data: payload };
  }
  return undefined;
}
