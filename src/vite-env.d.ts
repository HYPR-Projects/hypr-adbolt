/// <reference types="vite/client" />
/// <reference types="vitest" />

// CSS Modules
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// CDN-loaded libraries available on window
interface Window {
  // SheetJS (xlsx.full.min.js)
  XLSX: {
    utils: {
      book_new(): unknown;
      aoa_to_sheet(data: unknown[][]): unknown & { '!cols'?: unknown[] };
      book_append_sheet(wb: unknown, ws: unknown, name?: string): void;
      sheet_to_json(ws: unknown, opts?: { header?: number; defval?: string }): unknown[];
      /** Inject rows into an existing worksheet at a given A1-notation origin. */
      sheet_add_aoa(ws: unknown, data: unknown[][], opts?: { origin?: string | number | { r: number; c: number } }): void;
    };
    read(data: ArrayBuffer | Uint8Array, opts?: { type: string }): { Sheets: Record<string, unknown>; SheetNames: string[] };
    write(wb: unknown, opts?: { bookType: string; type: string }): ArrayBuffer;
    writeFile(wb: unknown, filename: string): void;
  };
  // JSZip (jszip.min.js)
  JSZip: {
    new(): JSZipInstance;
    loadAsync(data: ArrayBuffer | Blob): Promise<JSZipInstance>;
  };
}

interface JSZipInstance {
  files: Record<string, JSZipEntry>;
  file(path: string): JSZipEntry | null;
  file(path: string, data: string | Blob | ArrayBuffer): JSZipInstance;
  generateAsync(opts: {
    type: string;
    mimeType?: string;
    compression?: 'STORE' | 'DEFLATE';
    compressionOptions?: { level?: number } | null;
  }): Promise<Blob>;
}

interface JSZipEntry {
  dir: boolean;
  async(type: 'string'): Promise<string>;
  async(type: 'blob'): Promise<Blob>;
  async(type: 'arraybuffer'): Promise<ArrayBuffer>;
}
