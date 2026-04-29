/**
 * Streaming multipart upload — encaminha um arquivo do storage Supabase pra
 * uma API externa (Xandr /creative-upload, DV360 /assets/upload, etc.) sem
 * materializar o arquivo na memória do edge function.
 *
 * Por que existe: edge function Supabase tem ~256MB RAM por isolate. Baixar
 * blob de 100MB+ + montar FormData duplica memória até estourar (status 546
 * Worker OOM). Esse helper faz pipe direto: storage → ReadableStream →
 * TransformStream wrapper → fetch destino, com backpressure nativo.
 *
 * IMPORTANTE: usamos `pipeThrough(TransformStream)` em vez de `new ReadableStream`
 * com `controller.enqueue` em loop. ReadableStream manual NÃO respeita
 * backpressure — ele bufferiza tudo internamente e estoura RAM em arquivos
 * grandes. TransformStream + pipeThrough usa backpressure nativo: o source
 * só lê quando o destino consome.
 *
 * Limites reais das DSPs (validados via doc oficial):
 *   - Xandr /creative-upload: ~220MB
 *   - DV360 /assets/upload: 1GB pra videos
 *
 * Por que Content-Length explícito: Google APIs (DV360) rejeitam request
 * com Transfer-Encoding: chunked. Calculamos o tamanho total antes (preamble
 * + file size do storage + trailer) e setamos Content-Length no header.
 */

export interface MultipartField {
  name: string;
  /** Valor texto. Pra arquivos, use `file` em vez. */
  value: string;
  /** Content-Type opcional pro field (ex: "application/json"). */
  contentType?: string;
}

export interface StreamingUploadParams {
  /** URL de origem do arquivo (signed URL do storage Supabase). */
  sourceUrl: string;
  /** Tamanho do arquivo em bytes. Usado pra calcular Content-Length. */
  sourceSize: number;
  /** Nome do arquivo pro Content-Disposition. */
  fileName: string;
  /** MIME type do arquivo. */
  mimeType: string;
  /** Nome do campo file no multipart (ex: 'file' pra Xandr/DV360). */
  fileFieldName: string;
  /** Campos texto adicionais que vão antes do file no multipart. */
  fields?: MultipartField[];
  /** URL destino (Xandr/DV360 endpoint). */
  targetUrl: string;
  /** Headers adicionais (Authorization, etc.). */
  targetHeaders: Record<string, string>;
}

function escapeFilename(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Faz upload streaming de um arquivo do storage pra uma API externa,
 * sem carregar o arquivo na memória do edge function.
 */
export async function streamingMultipartUpload(params: StreamingUploadParams): Promise<Response> {
  const { sourceUrl, sourceSize, fileName, mimeType, fileFieldName, fields = [], targetUrl, targetHeaders } = params;
  const enc = new TextEncoder();
  const CRLF = '\r\n';

  const boundary = '----adbolt-' + crypto.randomUUID().replace(/-/g, '');

  let preambleStr = '';
  for (const field of fields) {
    preambleStr += `--${boundary}${CRLF}`;
    preambleStr += `Content-Disposition: form-data; name="${field.name}"${CRLF}`;
    if (field.contentType) {
      preambleStr += `Content-Type: ${field.contentType}${CRLF}`;
    }
    preambleStr += CRLF;
    preambleStr += `${field.value}${CRLF}`;
  }
  preambleStr += `--${boundary}${CRLF}`;
  preambleStr += `Content-Disposition: form-data; name="${fileFieldName}"; filename="${escapeFilename(fileName)}"${CRLF}`;
  preambleStr += `Content-Type: ${mimeType}${CRLF}${CRLF}`;
  const preamble = enc.encode(preambleStr);

  const trailer = enc.encode(`${CRLF}--${boundary}--${CRLF}`);
  const totalLength = preamble.length + sourceSize + trailer.length;

  // Fetch source — pega ReadableStream sem materializar bytes
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok || !sourceRes.body) {
    throw new Error(`Source fetch failed (${sourceRes.status}): ${await sourceRes.text().catch(() => '')}`);
  }

  // TransformStream prepende preamble (start) + appende trailer (flush).
  // Body do source flui via pipeThrough, com backpressure nativo do Web Streams.
  // Memória pico: 1 chunk (~64KB), não o arquivo inteiro.
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(preamble);
    },
    flush(controller) {
      controller.enqueue(trailer);
    },
  });

  const body = sourceRes.body.pipeThrough(transformer);

  return await fetch(targetUrl, {
    method: 'POST',
    headers: {
      ...targetHeaders,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(totalLength),
    },
    body,
    // @ts-expect-error duplex é Web Standard mas TS lib do Deno ainda não tem
    duplex: 'half',
  });
}

/**
 * Gera signed URL do storage Supabase pra usar como sourceUrl.
 * TTL default 30 min — suficiente pra qualquer upload realista.
 */
export async function getStorageSignedUrl(
  // deno-lint-ignore no-explicit-any
  sb: any,
  bucket: string,
  storagePath: string,
  ttlSeconds = 1800,
): Promise<{ signedUrl: string; size: number }> {
  const { data: signed, error: signErr } = await sb.storage
    .from(bucket)
    .createSignedUrl(storagePath, ttlSeconds);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`createSignedUrl failed: ${signErr?.message || 'no URL'}`);
  }

  // Pega size via HEAD na própria signed URL — mais simples que list e
  // funciona pra qualquer estrutura de pastas (list com search às vezes
  // não retorna o item esperado).
  const headRes = await fetch(signed.signedUrl, { method: 'HEAD' });
  if (!headRes.ok) {
    throw new Error(`HEAD signed URL failed: ${headRes.status}`);
  }
  const size = Number(headRes.headers.get('content-length') || 0);
  if (!size) throw new Error('Storage file size unknown (no content-length)');

  return { signedUrl: signed.signedUrl, size };
}
