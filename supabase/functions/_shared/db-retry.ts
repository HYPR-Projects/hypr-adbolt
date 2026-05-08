// Retry helper para writes críticos no banco. Usado pelos edge functions DSP
// quando o creative já foi criado na DSP mas precisamos persistir no nosso
// banco — uma falha transitória aqui criaria um "criativo zumbi" (existe na
// DSP, custa $$, mas não aparece no AdBolt).
//
// Uso típico:
//   const { error } = await retryDbWrite(
//     () => sb.from('creatives').insert(rows),
//     { context: 'creatives.insert', maxRetries: 3 },
//   );
//   if (error) {
//     // Logamos pra forensic, mas retornamos sucesso pro frontend com flag
//     // de zumbi pra o user/ops poder reconciliar.
//     console.error(`[zombie risk] ${context}: ${error}`);
//   }

interface RetryOptions {
  context: string; // pra logging — ex: 'creatives.insert', 'creative_batches.update'
  maxRetries?: number; // default 3
  baseDelayMs?: number; // default 500
}

interface RetryResult<T> {
  data: T | null;
  error: string | null;
  attempts: number;
}

export async function retryDbWrite<T>(
  // deno-lint-ignore no-explicit-any
  fn: () => any,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Backoff exponencial: 500ms, 1s, 2s, 4s. Cap em 4s pra não travar
      // a edge function (limit 150s wall clock total).
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 4000);
      console.warn(`[retryDbWrite] ${opts.context}: retry ${attempt}/${maxRetries} after ${delay}ms (last: ${lastError?.substring(0, 200)})`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const result = await fn();
      // supabase-js retorna { data, error } em vez de throw. Trata ambos os formatos.
      if (result?.error) {
        lastError = String(result.error.message || result.error);
        // Não retentar em erro de constraint (4xx-equivalent: payload ruim,
        // dado inválido). Retry só ajuda em transient (network, timeout).
        const code = result.error.code || '';
        if (code.startsWith('23')) { // 23xxx = postgres integrity violation
          return { data: null, error: lastError, attempts: attempt + 1 };
        }
        continue;
      }
      return { data: (result?.data ?? null) as T, error: null, attempts: attempt + 1 };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Network exception ou timeout — tenta de novo
    }
  }

  return { data: null, error: lastError, attempts: maxRetries + 1 };
}
