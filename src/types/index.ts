/* ══════════════════════════════════════════════
   AdBolt Core Types — re-exports

   This file preserves the public `@/types` surface.
   Types and constants live in themed files:
     - domain.ts    — DSPs, trackers, placements, assets (domain primitives)
     - db.ts        — Supabase row shapes (Creative, CreativeStatus, AuditStatus)
     - ui.ts        — runtime UI shapes (AssetEntry, CreativeGroup, wizard)
     - constants.ts — labels, limits, IAB sizes, wizard configs

   Consumers should keep importing from '@/types'.
   ══════════════════════════════════════════════ */

export * from './domain';
export * from './db';
export * from './ui';
export * from './constants';
