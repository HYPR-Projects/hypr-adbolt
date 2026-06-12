/**
 * Multi-file CM360 upload — merge semantics.
 * Simulates the real case: display export + instream video export of the
 * same campaign uploaded together (e.g. Smirnoff WorldCup DART + INSTREAM).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useWizardStore } from '@/stores/wizard';
import type { ParsedData, Placement } from '@/types';

function pl(id: string, name: string, type: 'display' | 'video'): Placement {
  return {
    placementId: id,
    placementName: name,
    dimensions: type === 'video' ? '1280x720' : '300x250',
    jsTag: type === 'display' ? `<ins class='dcmads' data-dcm-placement='${id}'></ins>` : '',
    vastTag: type === 'video' ? `https://ad.doubleclick.net/ddm/pfadx/${id};dc_vast=4` : '',
    clickUrl: type === 'display' ? `https://ad.doubleclick.net/ddm/jump/${id}` : '',
    type,
    trackers: [],
  };
}

const displayFile: ParsedData = {
  advertiserName: 'DIAGEO_BR_DISPLAY',
  campaignName: '26009425_WorldCupSelecof_SMIR_DISPLAY',
  brandName: 'DIAGEO_BR_DISPLAY',
  contentType: 'display',
  placements: [pl('P1', 'BHDE_PAISES-300X250', 'display'), pl('P2', 'BHDE_CAIPI-300X600', 'display')],
};

const videoFile: ParsedData = {
  advertiserName: 'DIAGEO_BR_VIDEO',
  campaignName: '26009425_WorldCupSelecof_SMIR_INSTREAM',
  brandName: '',
  contentType: 'video',
  placements: [pl('P3', 'BHDE_INSTREAM-VIDEO', 'video')],
};

describe('mergeParsedData — multi-file upload', () => {
  beforeEach(() => {
    useWizardStore.getState().resetWizard();
  });

  it('display + video files merge into mixed contentType with all placements', () => {
    const wz = useWizardStore.getState();
    let r = wz.mergeParsedData(displayFile);
    expect(r).toEqual({ added: 2, skipped: 0 });
    r = useWizardStore.getState().mergeParsedData(videoFile);
    expect(r).toEqual({ added: 1, skipped: 0 });

    const parsed = useWizardStore.getState().parsedData!;
    expect(parsed.placements).toHaveLength(3);
    expect(parsed.contentType).toBe('mixed');
  });

  it('metadata of the FIRST file wins; second file only fills gaps', () => {
    useWizardStore.getState().mergeParsedData(displayFile);
    useWizardStore.getState().mergeParsedData(videoFile);
    const parsed = useWizardStore.getState().parsedData!;
    expect(parsed.advertiserName).toBe('DIAGEO_BR_DISPLAY');
    expect(parsed.campaignName).toBe('26009425_WorldCupSelecof_SMIR_DISPLAY');
    expect(parsed.brandName).toBe('DIAGEO_BR_DISPLAY');
  });

  it('second file fills metadata gaps when the first file lacks it', () => {
    useWizardStore.getState().mergeParsedData({ ...videoFile, brandName: '' });
    useWizardStore.getState().mergeParsedData(displayFile);
    expect(useWizardStore.getState().parsedData!.brandName).toBe('DIAGEO_BR_DISPLAY');
  });

  it('re-uploading the same file dedupes by placementId', () => {
    useWizardStore.getState().mergeParsedData(displayFile);
    const r = useWizardStore.getState().mergeParsedData(displayFile);
    expect(r).toEqual({ added: 0, skipped: 2 });
    expect(useWizardStore.getState().parsedData!.placements).toHaveLength(2);
  });

  it('sequential merges read live store state (no lost update between files)', () => {
    // Regression guard for the old stale-closure bug: two files processed in
    // the same handler call must accumulate, never overwrite.
    const wz = useWizardStore.getState();
    wz.mergeParsedData(displayFile);
    wz.mergeParsedData(videoFile);
    wz.mergeParsedData({ ...displayFile, placements: [pl('P4', 'EXTRA-970X250', 'display')] });
    expect(useWizardStore.getState().parsedData!.placements.map((p) => p.placementId)).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
});
