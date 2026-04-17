import { describe, it, expect } from 'vitest';
import { DSP_CAPABILITIES, hasApiCapableDsp, filterApiCapable } from '@/lib/dsp-config';
import type { DspType } from '@/types';

describe('DSP_CAPABILITIES', () => {
  it('declares all four DSPs', () => {
    const keys = Object.keys(DSP_CAPABILITIES).sort();
    expect(keys).toEqual(['amazondsp', 'dv360', 'stackadapt', 'xandr']);
  });

  it('every DSP can at least generate templates', () => {
    for (const caps of Object.values(DSP_CAPABILITIES)) {
      expect(caps.template).toBe(true);
    }
  });

  it('DV360 and Xandr have API activation', () => {
    expect(DSP_CAPABILITIES.dv360.api).toBe(true);
    expect(DSP_CAPABILITIES.xandr.api).toBe(true);
  });

  it('StackAdapt and Amazon are template-only today', () => {
    expect(DSP_CAPABILITIES.stackadapt.api).toBe(false);
    expect(DSP_CAPABILITIES.amazondsp.api).toBe(false);
  });
});

describe('hasApiCapableDsp', () => {
  it('returns false for empty input', () => {
    expect(hasApiCapableDsp([])).toBe(false);
    expect(hasApiCapableDsp(new Set<DspType>())).toBe(false);
  });

  it('returns false when only template-only DSPs are selected', () => {
    expect(hasApiCapableDsp(['stackadapt'])).toBe(false);
    expect(hasApiCapableDsp(['amazondsp'])).toBe(false);
    expect(hasApiCapableDsp(['stackadapt', 'amazondsp'])).toBe(false);
  });

  it('returns true when at least one API-capable DSP is present', () => {
    expect(hasApiCapableDsp(['dv360'])).toBe(true);
    expect(hasApiCapableDsp(['xandr'])).toBe(true);
    expect(hasApiCapableDsp(['dv360', 'amazondsp'])).toBe(true);
    expect(hasApiCapableDsp(['stackadapt', 'xandr'])).toBe(true);
  });

  it('accepts a Set', () => {
    expect(hasApiCapableDsp(new Set<DspType>(['amazondsp', 'dv360']))).toBe(true);
    expect(hasApiCapableDsp(new Set<DspType>(['stackadapt']))).toBe(false);
  });
});

describe('filterApiCapable', () => {
  it('returns only API-capable DSPs', () => {
    expect(filterApiCapable(['dv360', 'xandr', 'stackadapt', 'amazondsp']).sort())
      .toEqual(['dv360', 'xandr']);
  });

  it('preserves input order', () => {
    expect(filterApiCapable(['amazondsp', 'xandr', 'stackadapt', 'dv360']))
      .toEqual(['xandr', 'dv360']);
  });

  it('returns empty array when nothing is API-capable', () => {
    expect(filterApiCapable(['stackadapt', 'amazondsp'])).toEqual([]);
    expect(filterApiCapable([])).toEqual([]);
  });
});
