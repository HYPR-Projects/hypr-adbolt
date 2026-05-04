// Streaming multipart upload v2 — peak memory ~1KB independente do tamanho do arquivo.
//
// Diferença pro v1: NÃO chama `await sourceRes.blob()`. Em vez disso, constrói
// o body como ReadableStream que emite: [header multipart][bytes do source em chunks][footer].
//
// Em Deno, ReadableStream body com Content-Length explícito **não** força
// Transfer-Encoding: chunked (verificado em Deno 2.x). Se o servidor target
// (Google API, etc) aceitar Content-Length, o upload vai como single contiguous body.
//
// Por que precisou: arquivos > ~80MB estouravam o isolate (status 546 OOM).
// `await blob()` materializa todos os bytes, e Deno fetch faz cópia interna
// durante serialização → peak ~2x do tamanho do arquivo.

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
 * Streaming multipart upload com peak memory baixíssimo. Source bytes nunca
 * são materializados — passam direto do source stream pro target stream em
 * chunks de ~64KB.
 *
 * Requer que o target aceite Content-Length explícito (não chunked encoding).
 */
export async function streamingMultipartUploadV2(
  params: StreamingUploadParams,
): Promise<Response> {
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

  // Pre-compute header e footer bytes pra calcular Content-Length exato
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

  // Abre source como stream (não materializa)
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok || !sourceRes.body) {
    throw new Error(`Source fetch failed: ${sourceRes.status}`);
  }
  const sourceReader = sourceRes.body.getReader();
  let sentSourceBytes = 0;
  let headerSent = false;
  let footerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 1. Header primeiro
      if (!headerSent) {
        controller.enqueue(headerBytes);
        headerSent = true;
        return;
      }
      // 3. Footer depois que source acabou
      if (footerSent) {
        controller.close();
        return;
      }
      // 2. Source em chunks
      const { done, value } = await sourceReader.read();
      if (done) {
        if (sentSourceBytes !== sourceSize) {
          controller.error(
            new Error(
              `Source size mismatch: header expected ${sourceSize}, actual ${sentSourceBytes}`,
            ),
          );
          return;
        }
        controller.enqueue(footerBytes);
        footerSent = true;
        return;
      }
      if (value && value.length) {
        sentSourceBytes += value.length;
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      sourceReader.cancel(reason).catch(() => {});
    },
  });

  return fetch(targetUrl, {
    method: "POST",
    headers: {
      ...targetHeaders,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": totalSize.toString(),
    },
    body: stream,
    // @ts-ignore: duplex é required em Deno quando body é ReadableStream
    duplex: "half",
  });
}
