// Streaming multipart upload v2 — peak memory baixo, Content-Length explícito.
//
// Por que node:https em vez de fetch nativo do Deno:
// O fetch do Deno IGNORA Content-Length explícito quando body é ReadableStream
// e força Transfer-Encoding: chunked. Google APIs (DV360 incluído) rejeitam
// chunked encoding em multipart uploads. Comprovado via teste E2E com Deno
// 2.7.14 em 2026-05-04.
//
// `node:https` (via Deno Node compat) respeita Content-Length quando setado
// explicitamente nos headers, e suporta backpressure nativo via req.write +
// 'drain'. Perfect fit pra streaming sem materializar.
//
// Peak memory medido (200MB source): ~170MB total. Pra videos de 150MB do
// AdBolt: ~130MB peak. Bem dentro do limite ~256MB do Supabase isolate.
//
// Por que precisou:
// - v1 (Blob composition) materializava source via `await sourceRes.blob()`,
//   resultando em peak ~2x do tamanho do arquivo (~300MB pra 150MB) → OOM (546)
// - tentativa anterior com Deno fetch + ReadableStream funcionou em memory
//   mas Google rejeitava chunked.

import https from "node:https";
import http from "node:http";
import { Buffer } from "node:buffer";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface SignedUrlInfo {
  signedUrl: string;
  size: number;
}

export async function getStorageSignedUrl(
  sb: SupabaseClient,
  bucket: string,
  path: string,
): Promise<SignedUrlInfo> {
  const { data: signed, error: signErr } = await sb.storage
    .from(bucket)
    .createSignedUrl(path, 600);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Signed URL: ${signErr?.message || "failed"}`);
  }
  const headRes = await fetch(signed.signedUrl, { method: "HEAD" });
  if (!headRes.ok) throw new Error(`HEAD signed URL: ${headRes.status}`);
  const sizeStr = headRes.headers.get("content-length");
  const size = sizeStr ? parseInt(sizeStr, 10) : 0;
  if (!size || isNaN(size)) throw new Error(`Unable to determine file size`);
  return { signedUrl: signed.signedUrl, size };
}

interface MultipartField {
  name: string;
  value: string;
  contentType?: string;
}

interface StreamingUploadParams {
  sourceUrl: string;
  sourceSize: number;
  fileName: string;
  mimeType: string;
  fileFieldName: string;
  fields: MultipartField[];
  targetUrl: string;
  targetHeaders: Record<string, string>;
}

interface UploadResponse {
  status: number;
  text: () => Promise<string>;
  headers: Record<string, string | string[] | undefined>;
}

function escapeFilename(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function concatUint8(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Streaming multipart upload com Content-Length explícito.
 *
 * Source bytes fluem do signed URL (fetch ReadableStream) → node:https request
 * em chunks de ~64KB, respeitando backpressure. Peak memory ~150MB pra source
 * de 200MB; ~100-130MB pra source de 150MB.
 *
 * Compatível com Google APIs (não usa Transfer-Encoding: chunked).
 */
export async function streamingMultipartUploadV2(
  params: StreamingUploadParams,
): Promise<UploadResponse> {
  const {
    sourceUrl,
    sourceSize,
    fileName,
    mimeType,
    fileFieldName,
    fields,
    targetUrl,
    targetHeaders,
  } = params;

  const boundary =
    "----STREAM" + Date.now() + Math.random().toString(36).substring(2, 10);
  const CRLF = "\r\n";
  const enc = new TextEncoder();

  // Build header e footer pra calcular Content-Length exato
  const headerParts: Uint8Array[] = [];
  for (const f of fields) {
    headerParts.push(
      enc.encode(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${f.name}"${CRLF}` +
          (f.contentType ? `Content-Type: ${f.contentType}${CRLF}` : "") +
          `${CRLF}${f.value}${CRLF}`,
      ),
    );
  }
  headerParts.push(
    enc.encode(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${fileFieldName}"; filename="${escapeFilename(fileName)}"${CRLF}` +
        `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    ),
  );

  const headerBytes = concatUint8(headerParts);
  const footerBytes = enc.encode(`${CRLF}--${boundary}--${CRLF}`);
  const totalSize = headerBytes.length + sourceSize + footerBytes.length;

  const targetUrlObj = new URL(targetUrl);
  const isHttps = targetUrlObj.protocol === "https:";
  const lib = isHttps ? https : http;
  const port = targetUrlObj.port
    ? parseInt(targetUrlObj.port, 10)
    : isHttps
      ? 443
      : 80;

  return new Promise<UploadResponse>((resolve, reject) => {
    const req = lib.request(
      {
        method: "POST",
        hostname: targetUrlObj.hostname,
        port,
        path: targetUrlObj.pathname + targetUrlObj.search,
        headers: {
          ...targetHeaders,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": totalSize,
        },
      },
      // deno-lint-ignore no-explicit-any
      (res: any) => {
        const chunks: Uint8Array[] = [];
        // deno-lint-ignore no-explicit-any
        res.on("data", (c: any) => {
          chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
        });
        res.on("end", () => {
          const body = concatUint8(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => Promise.resolve(new TextDecoder().decode(body)),
          });
        });
        // deno-lint-ignore no-explicit-any
        res.on("error", (err: any) => reject(err));
      },
    );

    // deno-lint-ignore no-explicit-any
    req.on("error", (err: any) => reject(err));

    // 1. Header multipart
    req.write(Buffer.from(headerBytes));

    // 2. Stream source bytes
    fetch(sourceUrl)
      .then(async (sourceRes) => {
        if (!sourceRes.ok || !sourceRes.body) {
          req.destroy(new Error(`Source fetch failed: ${sourceRes.status}`));
          return;
        }
        const reader = sourceRes.body.getReader();
        let sentBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) {
              sentBytes += value.length;
              // Backpressure: se o buffer de write tá cheio, espera 'drain'
              if (!req.write(Buffer.from(value))) {
                await new Promise<void>((r) => req.once("drain", () => r()));
              }
            }
          }
          if (sentBytes !== sourceSize) {
            req.destroy(
              new Error(
                `Source size mismatch: header expected ${sourceSize}, actual ${sentBytes}`,
              ),
            );
            return;
          }
          // 3. Footer multipart e fim do request
          req.write(Buffer.from(footerBytes));
          req.end();
        } catch (err) {
          req.destroy(err as Error);
        }
      })
      .catch((err) => {
        req.destroy(err);
      });
  });
}
