import { describe, it, expect } from 'vitest';
import { buildAggregatedResult } from '@/services/activation/aggregate';

describe('buildAggregatedResult', () => {
  it('returns error status when no results were collected', () => {
    const r = buildAggregatedResult('Xandr', []);
    expect(r.status).toBe('error');
    expect(r.dsp).toBe('Xandr');
    expect(r.detail).toBe('0/0 criativos criados');
    expect(r.results).toEqual([]);
  });

  it('returns success when every entry succeeded', () => {
    const r = buildAggregatedResult('DV360', [
      { name: 'a', success: true, creativeId: '1' },
      { name: 'b', success: true, creativeId: '2' },
      { name: 'c', success: true, creativeId: '3' },
    ]);
    expect(r.status).toBe('success');
    expect(r.detail).toBe('3/3 criativos criados');
  });

  it('returns partial when some succeeded and some failed', () => {
    const r = buildAggregatedResult('Xandr', [
      { name: 'a', success: true, creativeId: '1' },
      { name: 'b', success: false, error: 'falhou' },
      { name: 'c', success: true, creativeId: '2' },
    ]);
    expect(r.status).toBe('partial');
    expect(r.detail).toBe('2/3 criativos criados');
  });

  it('returns error when every entry failed', () => {
    const r = buildAggregatedResult('DV360', [
      { name: 'a', success: false, error: 'erro 1' },
      { name: 'b', success: false, error: 'erro 2' },
    ]);
    expect(r.status).toBe('error');
    expect(r.detail).toBe('0/2 criativos criados');
  });

  it('preserves the per-creative results array', () => {
    const input = [
      { name: 'foo', success: true, creativeId: '42' },
      { name: 'bar', success: false, error: 'whatever' },
    ];
    const r = buildAggregatedResult('Xandr', input);
    expect(r.results).toEqual(input);
  });

  it('handles a large aggregated batch (240 creatives)', () => {
    // Simula resultado típico de chunked processing: 8 sub-batches de 30
    // (240 total) com taxa de sucesso de ~95%
    const agg = Array.from({ length: 240 }, (_, i) => ({
      name: `creative-${i}`,
      success: i % 20 !== 0, // 12 falhas (5%)
      ...(i % 20 !== 0 ? { creativeId: `cid-${i}` } : { error: 'fail' }),
    }));
    const r = buildAggregatedResult('Xandr', agg);
    expect(r.status).toBe('partial');
    expect(r.detail).toBe('228/240 criativos criados');
    expect(r.results).toHaveLength(240);
  });

  it('handles the single-batch case (≤30 creatives, no chunking)', () => {
    // Pra batches pequenos só rola um sub-batch; mesmo helper, mesmo formato
    const agg = Array.from({ length: 5 }, (_, i) => ({
      name: `c${i}`,
      success: true,
      creativeId: `id${i}`,
    }));
    const r = buildAggregatedResult('DV360', agg);
    expect(r.status).toBe('success');
    expect(r.detail).toBe('5/5 criativos criados');
  });
});
