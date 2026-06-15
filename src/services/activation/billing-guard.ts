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
 * Audit the impression-firing trackers across all creatives.
 * Returns one issue per offending tracker. Empty array = safe to proceed.
 */
export function auditTrackerBilling(items: AuditItem[]): BillingIssue[] {
  const issues: BillingIssue[] = [];

  for (const item of items) {
    for (const t of item.trackers || []) {
      if (!t || !t.url) continue;
      const cls = classifyTrackerCell(t.url);
      const role = cls?.role ?? 'unknown';

      if (role === 'click') {
        issues.push({
          label: item.label,
          url: t.url,
          kind: 'click-as-impression',
          severity: 'block',
          detail: 'Tracker de clique no array de impressão — dispararia em volume de impressão.',
        });
      } else if (role === 'unknown') {
        issues.push({
          label: item.label,
          url: t.url,
          kind: 'unknown-purpose',
          severity: 'block',
          detail: 'Propósito do tracker não identificado — confirme manualmente antes de ativar.',
        });
      }
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
