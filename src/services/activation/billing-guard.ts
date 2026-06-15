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
  /** Video creatives fire VAST event trackers, not every tracker on impression. */
  isVideo?: boolean;
}

/**
 * Whether this tracker actually fires on an impression. Display trackers fire
 * on every render. Video (VAST) trackers fire on their event — only the
 * impression event (or an unset event, which defaults to impression) counts
 * at impression volume; click/quartile/etc. events do not.
 */
export function trackerFiresOnImpression(t: Tracker, isVideo: boolean): boolean {
  if (!isVideo) return true;
  return !t.eventType || t.eventType === 'impression';
}

/**
 * Reason a single tracker must be blocked from firing at impression volume,
 * or null if it's safe. Re-derives purpose from the URL (anti-spoof): a URL
 * that resolves to 'click' is ALWAYS blocked when it fires on impression —
 * `confirmed` cannot override it. Only a genuinely-unknown vendor pixel can be
 * unblocked by human confirmation. A tracker that does not fire on impression
 * (e.g. a VAST click-event tracker on a video) is never an over-count risk.
 */
export function trackerBlockReason(t: Tracker, isVideo = false): BillingIssueKind | null {
  if (!t || !t.url) return null;
  if (!trackerFiresOnImpression(t, isVideo)) return null;
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
      const kind = trackerBlockReason(t, !!item.isVideo);
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
