import type { ActivationResult } from '@/types';

interface PerCreativeResult {
  name: string;
  success: boolean;
  creativeId?: string;
  error?: string;
}

/**
 * Agrega os resultados de múltiplos sub-batches em um único ActivationResult
 * por DSP. Usado pelo chunked processing em StepActivate.
 *
 * Regra de status:
 *   - agg vazio              -> 'error' (nenhum criativo entrou — DSP foi
 *                                        selecionada mas não rodou de fato)
 *   - todos com success      -> 'success'
 *   - alguns com success     -> 'partial'
 *   - nenhum com success     -> 'error'
 *
 * detail: "OK/TOTAL criativos criados"
 */
export function buildAggregatedResult(
  dsp: string,
  agg: PerCreativeResult[],
): ActivationResult {
  const ok = agg.filter((r) => r.success).length;
  const status: ActivationResult['status'] =
    agg.length === 0 ? 'error' :
    ok === agg.length ? 'success' :
    ok > 0 ? 'partial' : 'error';
  return {
    dsp,
    status,
    detail: `${ok}/${agg.length} criativos criados`,
    results: agg,
  };
}
