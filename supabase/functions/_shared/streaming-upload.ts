/**
 * Streaming multipart upload — encaminha um arquivo do storage Supabase pra
 * uma API externa (Xandr /creative-upload, DV360 /assets/upload, etc.) sem
 * materializar o arquivo na memória do edge function.
 *
 * Por que existe: edge function Supabase tem ~256MB RAM por isolate. Baixar
 * blob de 100MB+ + montar FormData duplica memória até estourar (status 546
 * Worker OOM). Esse helper faz pipe direto: storage → ReadableStream do fetch
 * → multipart wrapper → fetch destino, em chunks de ~64KB.
 *
 * Limites reais das DSPs (validados via doc oficial):
 *   - Xandr /creative-upload: ~220MB
 *   - DV360 /assets/upload: 1GB pra videos
 *
 * Esse helper suporta qualquer tamanho até esses limites.
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

/**
 * Escape de filename pra header Content-Disposition (RFC 6266).
 * Backslash e aspas precisam ser escapados; outros caracteres podem ficar.
 */
function escapeFilename(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Faz upload streaming de um arquivo do storage pra uma API externa,
 * sem carregar o arquivo na memória do edge function.
 *
 * Retorna a Response do POST destino. Caller é responsável por parsear
 * o body (geralmente JSON) e tratar status codes.
 */
export async function streamingMultipartUpload(params: StreamingUploadParams): Promise<Response> {
  const { sourceUrl, sourceSize, fileName, mimeType, fileFieldName, fields = [], targetUrl, targetHeaders } = params;
  const enc = new TextEncoder();
  const CRLF = '\r\n';

  // Boundary suficientemente único pra não colidir com bytes do binário.
  // Prefixo + UUID dá ~32 chars random, well below RFC 2046 limit (70 chars).
  const boundary = '----adbolt-' + crypto.randomUUID().replace(/-/g, '');

  // ── Preamble ──────────────────────────────────────────────────
  // Cada field texto vira um part:
  //   --boundary\r\n
  //   Content-Disposition: form-data; name="x"\r\n
  //   [Content-Type: ...\r\n]   ← opcional
  //   \r\n
  //   value\r\n
  //
  // Depois o file part começa, mas SEM o body (body vem do stream).
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

  // ── Trailer ───────────────────────────────────────────────────
  // Após os bytes do file: \r\n + closing boundary
  const trailer = enc.encode(`${CRLF}--${boundary}--${CRLF}`);

  // ── Content-Length total ──────────────────────────────────────
  // Necessário porque Google APIs rejeitam Transfer-Encoding: chunked.
  const totalLength = preamble.length + sourceSize + trailer.length;

  // ── Fetch source como stream ──────────────────────────────────
  // Importante: NÃO chamar .blob() ou .arrayBuffer() — isso materializa
  // todo o arquivo na memória. Pegar res.body que é ReadableStream<Uint8Array>.
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok || !sourceRes.body) {
    throw new Error(`Source fetch failed (${sourceRes.status}): ${await sourceRes.text().catch(() => '')}`);
  }
  const sourceStream = sourceRes.body;

  // ── Stream de saída: preamble → source bytes → trailer ────────
  // ReadableStream concatena os 3 segments. Bytes do source passam direto
  // por reader.read() → controller.enqueue() em chunks de ~64KB
  // (tamanho default do TCP socket buffer).
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      const reader = sourceStream.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } finally {
        reader.releaseLock();
      }
      controller.enqueue(trailer);
      controller.close();
    },
    cancel(reason) {
      // Se o fetch destino abortar (rede, timeout), liberar o reader.
      void sourceStream.cancel(reason);
    },
  });

  // ── POST destino com body streamed ────────────────────────────
  // duplex: 'half' é obrigatório em fetch quando body é ReadableStream
  // (Web Streams spec). Deno suporta a partir de 1.35.
  return await fetch(targetUrl, {
    method: 'POST',
    headers: {
      ...targetHeaders,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(totalLength),
    },
    body,
    // @ts-expect-error duplex é Web Standard mas TS lib do Deno ainda não tem nos types
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

  // Pega tamanho via list — único jeito confiável sem download
  // (HEAD request no signed URL também funciona, mas list é mais rápido em pasta plana).
  const folder = storagePath.split('/').slice(0, -1).join('/') || '';
  const fileName = storagePath.split('/').pop() || '';
  const { data: items, error: listErr } = await sb.storage
    .from(bucket)
    .list(folder, { search: fileName, limit: 1 });
  if (listErr || !items?.length) {
    throw new Error(`Storage list failed: ${listErr?.message || 'file not found'}`);
  }
  const size = Number(items[0].metadata?.size || 0);
  if (!size) throw new Error('Storage file size unknown');

  return { signedUrl: signed.signedUrl, size };
}
