/* ══════════════════════════════════════════════════════════════
   Pre-activation billing guard

   The catastrophic failure mode this guards against: a tracker that
   counts CLICKS ends up in a creative's impression-firing tracker
   array. Display trackers fire on every render, so a click counter
   placed there is billed at impression volume — the multiplier that
   turned a ~R$500 line item into a ~R$100k charge in the past.

   This is a deterministic gate, not a guess. It re-derives each
   tracker's purpose from its URL signature at activation time (it does
   NOT trust any stored `role`, which could be stale or hand-edited)
   and BLOCKS when it finds:
     • a click tracker sitting among impression-firing trackers
     • a tracker whose purpose cannot be determined (unknown)

   High-precision impression/verification beacons (e.g. DoubleVerify)
   pass — firing on impression is their intended behavior.
   ══════════════════════════════════════════════════════════════ */

import type { Tracker } from '@/types';
import { classifyTrackerCell } from '@/parsers/asset-sheet';

export type BillingIssueKind = 'click-as-impression' | 'unknown-purpose';

export interface BillingIssue {
  /** Creative/placement label for the message. */
  label: string;
  url: string;
  kind: BillingIssueKind;
  severity: 'block';
  detail: string;
}

export interface AuditItem {
  label: string;
  trackers: Tracker[];
}

/**
 * Reason a single tracker must be blocked, or null if safe. Re-derives purpose
 * from the URL (anti-spoof): a 'click' URL is ALWAYS blocked — `confirmed`
 * cannot override it. Only a genuinely-unknown vendor pixel can be unblocked by
 * human confirmation.
 *
 * IMPORTANT — why there is no per-event exemption: the Xandr and DV360 edge
 * functions attach EVERY tracker as an impression beacon (Xandr hardcodes
 * vast_event_type_id 9; DV360 hardcodes THIRD_PARTY_URL_TYPE_IMPRESSION) and
 * ignore `eventType`. So any tracker that reaches the array fires at impression
 * volume regardless of a 'click' eventType. Treating a click tracker as safe
 * because its eventType says 'click' would be unsound against the real DSP
 * behavior — exactly the over-count we guard against.
 */
export function trackerBlockReason(t: Tracker): BillingIssueKind | null {
  if (!t || !t.url) return null;
  const role = classifyTrackerCell(t.url)?.role ?? 'unknown';
  if (role === 'click') return 'click-as-impression';
  if (role === 'impression' || role === 'verification') return null;
  // unknown — allow only if a human explicitly vouched for it in review
  return t.confirmed ? null : 'unknown-purpose';
}

/**
 * Audit the impression-firing trackers across all creatives.
 * Returns one issue per offending tracker. Empty array = safe to proceed.
 */
export function auditTrackerBilling(items: AuditItem[]): BillingIssue[] {
  const issues: BillingIssue[] = [];

  for (const item of items) {
    for (const t of item.trackers || []) {
      const kind = trackerBlockReason(t);
      if (!kind) continue;
      issues.push({
        label: item.label,
        url: t.url,
        kind,
        severity: 'block',
        detail: kind === 'click-as-impression'
          ? 'Tracker de clique no array de impressão — dispararia em volume de impressão.'
          : 'Propósito do tracker não identificado — confirme manualmente antes de ativar.',
      });
    }
  }

  return issues;
}

/** Format a short, human-readable block message from audit issues. */
export function formatBillingBlock(issues: BillingIssue[], max = 3): string {
  const n = issues.length;
  const sample = issues.slice(0, max).map((i) => `${i.label} (${i.kind === 'click-as-impression' ? 'click→impressão' : 'desconhecido'})`);
  const extra = n > max ? ` +${n - max}` : '';
  return `${n} tracker(s) bloqueado(s) por risco de billing: ${sample.join(', ')}${extra}. Revise antes de ativar.`;
}
