import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';

const TYPEFORM_PROXY = import.meta.env.VITE_TYPEFORM_PROXY ||
  `${SUPABASE_FUNCTIONS_URL}/typeform-proxy`;

/**
 * Extract a Typeform form ID from a URL or raw ID.
 * Ported from legacy: function extractFormId(url) — line 2077
 */
export function extractFormId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/typeform\.com\/to\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{4,12}$/.test(url.trim())) return url.trim();
  return null;
}

/**
 * Fetch a Typeform title via the proxy edge function.
 * Ported from legacy: async function fetchTypeformTitle(formId) — line 2078
 */
export async function fetchTypeformTitle(formId: string): Promise<string> {
  const res = await fetch(`${TYPEFORM_PROXY}?form_id=${formId}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.title || formId;
}

/**
 * Detect survey variant (Controle/Exposto) from title.
 * Ported from legacy: function detectVariant(title) — line 2027
 */
export function detectVariant(title: string): string {
  const t = (title || '').toLowerCase();
  if (t.includes('controle') || t.includes('control')) return 'Controle';
  if (t.includes('exposto') || t.includes('exposed')) return 'Exposto';
  return '';
}

/**
 * Build an iframe tag for a Typeform survey.
 * Ported from legacy: function buildIframe(formId, size) — line 2080
 */
export function buildSurveyIframe(formId: string, size: string): string {
  const [w, h] = size.split('x');
  return `<iframe src="https://form.typeform.com/to/${formId}" width="${w}" height="${h}" frameborder="0" style="border:0;" allowfullscreen></iframe>`;
}

/**
 * Parsed survey info extracted from a Typeform title.
 */
export interface TypeformSurvey {
  id: string;
  title: string;
  brand: string;
  type: string;
  variant: string;
  lastUpdated: string;
  url: string;
}

/**
 * Parse a Typeform survey title into brand, type, and variant.
 *
 * Real patterns observed:
 *   HYPR_Survey_JLR_RRS_Awareness_Controle_Abr26
 *   HYPR_Survey_Reckitt_Big_Promo_Probabilidade_Abr26_Exposto
 *   HYPR_Survey_Electrolux_Flag_Colombia_Abr26_Exposto
 *   HYPR_Survey_PicPay_DarkTes_WillBank_Controle
 *   Amazon_ConsumerDay2026_Survey_Favorability_Exposto
 *   Kenvue_Baby_Promo_Survey_Intent_Controle_Abr26
 *   JLR_AON_Defender_V2_DefenderOnly_Awareness_Mar26_Exposto
 *   Nestle_Nutren_Senior_Survey_Awareness_Drogaria-SaoPaulo
 */
export function parseSurveyTitle(title: string): { brand: string; type: string; variant: string; displayName: string } {
  const variant = detectVariant(title);

  // Remove HYPR_ and/or Survey_ prefix (can appear in either order or both)
  let clean = title
    .replace(/^HYPR[_\s]*/i, '')
    .replace(/^Survey[_\s]*/i, '');

  const displayName = clean.replace(/_/g, ' ');

  // Split into parts and strip noise tokens
  let parts = clean.split('_').filter(Boolean);

  // Remove variant tokens wherever they appear
  parts = parts.filter((p) => !/^(Controle|Control|Exposto|Exposed)$/i.test(p));

  // Remove period tokens (Abr26, Mar26, Jan25, etc.) wherever they appear
  parts = parts.filter((p) => !/^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\d{2}$/i.test(p));

  // Remove stray "Survey" in the middle (e.g. "Kenvue_Baby_Promo_Survey_Intent")
  parts = parts.filter((p) => p.toLowerCase() !== 'survey');

  // Known survey type words
  const typeWords = new Set([
    'awareness', 'associacao', 'associação', 'association', 'atitude',
    'favoritismo', 'intencao', 'intenção', 'intent',
    'preferencia', 'preferência', 'probabilidade',
    'consideration', 'recall', 'favorability',
  ]);

  // Normalization map for display
  const typeNorm: Record<string, string> = {
    associacao: 'Associação', association: 'Associação',
    intencao: 'Intenção', intent: 'Intenção',
    preferencia: 'Preferência', favorability: 'Favorability',
    probabilidade: 'Probabilidade', consideration: 'Consideration',
    awareness: 'Awareness', atitude: 'Atitude',
    favoritismo: 'Favoritismo', recall: 'Recall',
  };

  // Find the FIRST type word (scan left-to-right — type is usually after brand)
  let typeIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (typeWords.has(parts[i].toLowerCase())) {
      typeIdx = i;
      break;
    }
  }

  let brand: string;
  let type: string;
  if (typeIdx >= 0) {
    brand = parts.slice(0, typeIdx).join(' ');
    const rawType = parts[typeIdx].toLowerCase();
    type = typeNorm[rawType] || parts[typeIdx].charAt(0).toUpperCase() + parts[typeIdx].slice(1);
  } else {
    // No type detected — brand is everything, type is empty (user must set manually)
    brand = parts.join(' ');
    type = '';
  }

  // Clean up brand: remove filler words that aren't useful for identification
  brand = brand.replace(/\b(Promo|Big)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (!brand && parts.length > 0) brand = parts[0];

  return { brand, type, variant, displayName };
}

/**
 * Fetch the latest surveys from the Typeform workspace.
 */
export async function fetchSurveyList(pageSize = 50): Promise<TypeformSurvey[]> {
  const res = await fetch(`${TYPEFORM_PROXY}?action=list&page_size=${pageSize}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();

  return (data.forms || []).map((f: { id: string; title: string; last_updated_at: string; url: string }) => {
    const parsed = parseSurveyTitle(f.title);
    return {
      id: f.id,
      title: f.title,
      brand: parsed.brand,
      type: parsed.type,
      variant: parsed.variant,
      lastUpdated: f.last_updated_at,
      url: f.url,
    };
  });
}
