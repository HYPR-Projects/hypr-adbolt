/**
 * AdBolt Tag Linter — preflight rules for CM360 embed tags before the DSP push.
 *
 * This module is the single home for tag-level rules. The UI (StepTags preflight
 * panel, StepActivate gate) only *consumes* lintTag / lintPlacement — never
 * reimplements a rule. Add new rules here, not in the components.
 *
 * Rules implemented:
 *  1. Display dcmads tag missing `data-dcm-click-tracker` → the DSP can't enter
 *     the click chain, so clicks count zero. Deterministic auto-fix: inject
 *     `data-dcm-click-tracker='${CLICK_URL}'` (the DSP-side click macro, filled
 *     at serve time by both DV360 and Xandr) and force rendering-mode='script'.
 *  2. Placement bound to one platform pushed to another (token mismatch). A
 *     DV360-designated placement on Xandr renders blank. Hard block, no auto-fix
 *     (it's a setup/routing error, AdBolt won't invent a creative).
 *  3. VAST tag with a static/`[timestamp]` `ord=` value pushed to Xandr. DV360
 *     fills ord natively; Xandr does not → no cachebusting. Auto-fix: ord=${CACHEBUSTER}.
 *  4. VAST content problems (no MediaFile, Duration 00:00:00, no ClickThrough,
 *     non-https URL inside the XML). These live in CM360, not in the tag string,
 *     so AdBolt only flags them — never auto-fixes.
 *
 * Severity contract: an auto-corrected blocker does NOT gate the push (the user
 * approves the diff and proceeds). Only blockers without an auto-fix and CM360
 * flags at 'bloqueia' level set status='blocked'.
 */

import type { DspType } from '@/types';
import { platformToken } from '@/lib/dsp-config';

// ── Public types ──

export type LintNivel = 'bloqueia' | 'aviso';
export type LintStatus = 'ok' | 'fixed' | 'blocked';
export type LintTipo = 'display' | 'video' | 'desconhecido';

export interface LintIssue {
  /** Stable code for dedup / tests (e.g. 'missing-click-tracker'). */
  code: string;
  nivel: LintNivel;
  /** True if this module can deterministically fix it at the tag level. */
  autofix: boolean;
  mensagem: string;
}

export interface LintFlagCM360 {
  code: string;
  nivel: LintNivel;
  /** Always external — resolve with the ad server, never auto-fixed. */
  mensagem: string;
}

export interface LintResult {
  tipo: LintTipo;
  status: LintStatus;
  issues: LintIssue[];
  /** Tag with every auto-fix applied, or null when nothing was fixable. */
  tagCorrigida: string | null;
  flagsCM360: LintFlagCM360[];
}

export interface LintInput {
  /** jsTag (display) or VAST tag URL (video). */
  tag: string;
  /** Target DSP for DSP-aware rules; null = run only DSP-agnostic rules. */
  targetDSP: DspType | null;
  placementName?: string;
  /** Resolved VAST XML, when available — enables rule 4. */
  vastXml?: string | null;
}

// ── Detection helpers ──

const CLICK_TRACKER_RE = /data-dcm-click-tracker\s*=/i;
const DCMADS_RE = /class\s*=\s*['"][^'"]*\bdcmads\b/i;
const INS_OPEN_RE = /<ins\b[\s\S]*?>/i;
const RENDERING_MODE_RE = /data-dcm-rendering-mode\s*=\s*(['"])([^'"]*)\1/i;
const ORD_RE = /([?&;]ord=)(\[[^\]]*\]|\$\{[^}]*\}|[^&;'"\s]*)/i;
const CLICK_MACRO = "${CLICK_URL}";

function looksLikeVast(tag: string, vastXml?: string | null): boolean {
  if (vastXml && vastXml.trim()) return true;
  return /<VAST\b/i.test(tag) || /\/pfadx\b|\/ddm\/|dartSearch|\bord=/i.test(tag);
}

function looksLikeDisplay(tag: string): boolean {
  return DCMADS_RE.test(tag) || /<ins\b/i.test(tag) || /<script\b/i.test(tag);
}

function detectTipo(tag: string, vastXml?: string | null): LintTipo {
  if (looksLikeVast(tag, vastXml)) return 'video';
  if (looksLikeDisplay(tag)) return 'display';
  return 'desconhecido';
}

/** Leading whitespace of the line containing position `pos`. */
function lineIndent(text: string, pos: number): string {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const m = text.slice(start, pos).match(/^\s*/);
  return m ? m[0] : '    ';
}

// ── Rule 1: click tracker + script rendering mode ──

function ensureScriptMode(tag: string): { tag: string; changed: boolean } {
  const rm = tag.match(RENDERING_MODE_RE);
  if (rm) {
    if (rm[2].toLowerCase() === 'script') return { tag, changed: false };
    return { tag: tag.replace(rm[0], `data-dcm-rendering-mode=${rm[1]}script${rm[1]}`), changed: true };
  }
  const open = tag.match(INS_OPEN_RE);
  if (open && open.index != null) {
    const at = open.index + open[0].length - 1; // before '>'
    return { tag: tag.slice(0, at) + ` data-dcm-rendering-mode='script'` + tag.slice(at), changed: true };
  }
  return { tag, changed: false };
}

function injectClickTracker(tag: string): string {
  if (CLICK_TRACKER_RE.test(tag)) return tag;
  const attr = `data-dcm-click-tracker='${CLICK_MACRO}'`;
  const rm = tag.match(RENDERING_MODE_RE);
  if (rm && rm.index != null) {
    const at = rm.index + rm[0].length;
    const indent = lineIndent(tag, rm.index);
    return tag.slice(0, at) + `\n${indent}${attr}` + tag.slice(at);
  }
  const open = tag.match(INS_OPEN_RE);
  if (open && open.index != null) {
    const at = open.index + open[0].length - 1; // before '>'
    return tag.slice(0, at) + ` ${attr}` + tag.slice(at);
  }
  return tag;
}

// ── Rule 3: VAST ord cachebuster (Xandr) ──

function fixOrd(tag: string): { tag: string; hadIssue: boolean } {
  const m = tag.match(ORD_RE);
  if (!m) return { tag, hadIssue: false };
  if (m[2] === '${CACHEBUSTER}') return { tag, hadIssue: false };
  return { tag: tag.replace(m[0], `${m[1]}\${CACHEBUSTER}`), hadIssue: true };
}

// ── Rule 4: VAST content (CM360 flags, never auto-fixed) ──

function vastContentFlags(xml: string): LintFlagCM360[] {
  const flags: LintFlagCM360[] = [];
  const hasMediaFile = /<MediaFile\b/i.test(xml);
  const hasWrapper = /<VASTAdTagURI\b/i.test(xml);
  if (!hasMediaFile && !hasWrapper) {
    flags.push({ code: 'vast-no-mediafile', nivel: 'bloqueia', mensagem: 'VAST sem MediaFile nem wrapper — Xandr rejeita ("Creative Does Not Display Properly").' });
  }
  const dur = xml.match(/<Duration[^>]*>([\s\S]*?)<\/Duration>/i);
  const durVal = dur ? dur[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  if (!durVal || /^0{2}:0{2}:0{2}(\.0+)?$/.test(durVal)) {
    flags.push({ code: 'vast-bad-duration', nivel: 'bloqueia', mensagem: `VAST com Duration inválida (${durVal || 'ausente'}) — corrigir no CM360.` });
  }
  if (!/<ClickThrough\b/i.test(xml)) {
    flags.push({ code: 'vast-no-clickthrough', nivel: 'aviso', mensagem: 'VAST sem ClickThrough — clique do vídeo não terá destino.' });
  }
  if (/(?:src|href)\s*=\s*['"]http:\/\//i.test(xml) || /["'>(\s]http:\/\//i.test(xml)) {
    flags.push({ code: 'vast-http-url', nivel: 'aviso', mensagem: 'VAST contém URL http:// (não-https) — pode ser bloqueada em ambiente seguro.' });
  }
  return flags;
}

// ── Core: lint a single tag against a single DSP ──

export function lintTag(input: LintInput): LintResult {
  const { tag, targetDSP, placementName, vastXml } = input;
  const tipo = detectTipo(tag, vastXml);
  const issues: LintIssue[] = [];
  const flagsCM360: LintFlagCM360[] = [];
  let work = tag;
  let fixed = false;

  // Rule 2 — platform token mismatch (DSP-aware).
  if (targetDSP && placementName) {
    const token = platformToken(placementName);
    if (token && token !== 'neutral' && token !== targetDSP) {
      // The documented blank-render failure is DV360-bound placements pushed
      // elsewhere; hard-block that case. Other concrete mismatches are flagged
      // as warnings (routing smell, not a guaranteed blank).
      const isHardBlank = token === 'dv360';
      issues.push({
        code: 'platform-mismatch',
        nivel: isHardBlank ? 'bloqueia' : 'aviso',
        autofix: false,
        mensagem: isHardBlank
          ? `Placement designada para DV360 sendo enviada ao ${targetDSP.toUpperCase()} — renderiza em branco. Roteie para DV360 ou remova.`
          : `Placement com token de plataforma (${token.toUpperCase()}) diferente do destino (${targetDSP.toUpperCase()}) — confirme o roteamento.`,
      });
    }
  }

  if (tipo === 'display') {
    // Rule 1 — click tracker + script mode.
    if (!CLICK_TRACKER_RE.test(work)) {
      const sm = ensureScriptMode(work);
      work = injectClickTracker(sm.tag);
      fixed = true;
      issues.push({
        code: 'missing-click-tracker',
        nivel: 'bloqueia',
        autofix: true,
        mensagem: 'Tag sem data-dcm-click-tracker — a DSP não entra na click chain e o clique fica zerado.',
      });
    } else {
      // Click tracker present but rendering mode may still be wrong.
      const sm = ensureScriptMode(work);
      if (sm.changed) {
        work = sm.tag;
        fixed = true;
        issues.push({
          code: 'rendering-mode',
          nivel: 'aviso',
          autofix: true,
          mensagem: 'rendering-mode ajustado para "script".',
        });
      }
    }
  }

  if (tipo === 'video') {
    // Rule 3 — ord cachebuster, Xandr only (DV360 fills ord natively).
    if (targetDSP === 'xandr') {
      const r = fixOrd(work);
      if (r.hadIssue) {
        work = r.tag;
        fixed = true;
        issues.push({
          code: 'vast-ord-cachebuster',
          nivel: 'aviso',
          autofix: true,
          mensagem: 'ord= estático/[timestamp] — Xandr não faz cachebusting. Trocado por ${CACHEBUSTER}.',
        });
      }
    }
    // Rule 4 — VAST content flags (only when XML is available).
    if (vastXml && vastXml.trim()) {
      flagsCM360.push(...vastContentFlags(vastXml));
    }
  }

  const tagCorrigida = fixed && work !== tag ? work : null;
  const hardBlocked =
    issues.some((i) => i.nivel === 'bloqueia' && !i.autofix) ||
    flagsCM360.some((f) => f.nivel === 'bloqueia');
  const status: LintStatus = hardBlocked ? 'blocked' : tagCorrigida ? 'fixed' : 'ok';

  return { tipo, status, issues, tagCorrigida, flagsCM360 };
}

// ── Convenience: lint a Placement against all selected DSPs ──

export interface LintablePlacement {
  placementName: string;
  type: 'display' | 'video';
  jsTag: string;
  vastTag: string;
}

/**
 * Lint a placement against every selected DSP and merge the results into one.
 * Auto-fixes accumulate across DSP passes (e.g. click tracker from the agnostic
 * pass + ord cachebuster from the Xandr pass chain into a single tagCorrigida).
 * With no DSP selected yet, only DSP-agnostic rules run (rule 1).
 */
export function lintPlacement(
  p: LintablePlacement,
  dsps: DspType[],
  vastXml?: string | null,
): LintResult {
  const baseTag = p.type === 'video' ? (p.vastTag || p.jsTag) : p.jsTag;
  const targets: (DspType | null)[] = dsps.length ? dsps : [null];

  const issues: LintIssue[] = [];
  const flagsCM360: LintFlagCM360[] = [];
  const seenIssue = new Set<string>();
  const seenFlag = new Set<string>();
  let work = baseTag;
  let tipo: LintTipo = 'desconhecido';

  for (const d of targets) {
    const r = lintTag({ tag: work, targetDSP: d, placementName: p.placementName, vastXml });
    tipo = r.tipo;
    for (const i of r.issues) {
      if (!seenIssue.has(i.code)) { seenIssue.add(i.code); issues.push(i); }
    }
    for (const f of r.flagsCM360) {
      if (!seenFlag.has(f.code)) { seenFlag.add(f.code); flagsCM360.push(f); }
    }
    if (r.tagCorrigida) work = r.tagCorrigida; // chain fixes
  }

  const tagCorrigida = work !== baseTag ? work : null;
  const hardBlocked =
    issues.some((i) => i.nivel === 'bloqueia' && !i.autofix) ||
    flagsCM360.some((f) => f.nivel === 'bloqueia');
  const status: LintStatus = hardBlocked ? 'blocked' : tagCorrigida ? 'fixed' : 'ok';

  return { tipo, status, issues, tagCorrigida, flagsCM360 };
}

/** Aggregate counts for headers and the activate gate. */
export function summarizeLint(results: LintResult[]) {
  let blocked = 0, fixable = 0, avisos = 0, cm360 = 0;
  for (const r of results) {
    if (r.status === 'blocked') blocked++;
    if (r.tagCorrigida) fixable++;
    avisos += r.issues.filter((i) => i.nivel === 'aviso').length;
    cm360 += r.flagsCM360.length;
  }
  return { blocked, fixable, avisos, cm360 };
}
