/**
 * Retry wrapper for Edge Function fetch calls.
 *
 * Retries on:
 *   - 429 (rate limited) — respects Retry-After header if present, else
 *     exponential backoff. Cap a 30s pra não travar UI.
 *   - 502, 503, 504 (Supabase cold starts / gateway timeouts) — exponential backoff.
 *   - Network errors (offline, DNS, fetch throw) — exponential backoff.
 *
 * Does NOT retry on:
 *   - 2xx (success)
 *   - Other 4xx (client errors — payload bug, auth fail; retrying won't help)
 *   - 5xx fora dos listados (erro genuíno do server, retry não resolve)
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

/** Lê o header Retry-After. Pode vir como segundos (number) ou HTTP-date. */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  // Formato 1: número de segundos
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  // Formato 2: HTTP-date (RFC 7231)
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_MS);
  }
  return null;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }

      // Retryable status — calcula delay e tenta de novo
      if (attempt < maxRetries) {
        // Pra 429: priorizar Retry-After do server. Cap em 30s pra não
        // travar a UI; se rate limit pedir mais que isso, deixa retornar
        // o 429 pro chamador lidar.
        const retryAfterMs = res.status === 429
          ? parseRetryAfter(res.headers.get('Retry-After'))
          : null;
        const delay = retryAfterMs !== null
          ? retryAfterMs
          : Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[retry] ${res.status} on attempt ${attempt + 1}, retrying in ${delay}ms${retryAfterMs !== null ? ' (Retry-After)' : ''}...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return res;
      }
    } catch (err) {
      // Network error (offline, DNS, etc.)
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[retry] Network error on attempt ${attempt + 1}, retrying in ${delay}ms...`, err);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('fetchWithRetry exhausted all attempts');
}
