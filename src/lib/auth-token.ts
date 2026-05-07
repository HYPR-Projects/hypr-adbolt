import { supabase } from '@/services/supabase';

/**
 * Pega o access_token atual da sessão Supabase.
 *
 * Por que existe: capturar `session.access_token` em uma variável no início
 * de uma operação longa (>1h) trava com o token antigo, mesmo que o
 * supabase-js renove a sessão em background. Sempre que precisar do token,
 * chame `getFreshToken()` — internamente consulta `supabase.auth.getSession()`,
 * que retorna a sessão atual (já refreshed se foi o caso).
 *
 * Uso típico em loops de ativação:
 *   for (const asset of assets) {
 *     const token = await getFreshToken();
 *     await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
 *   }
 */
export async function getFreshToken(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) {
    throw new Error('Sessão expirou. Faça login novamente pra continuar.');
  }
  return session.access_token;
}

export type TokenProvider = () => Promise<string>;
