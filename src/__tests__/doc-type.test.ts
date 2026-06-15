import { describe, it, expect } from 'vitest';
import { detectDocType } from '@/parsers/doc-type';

describe('detectDocType', () => {
  it('classifies a DoubleVerify tag sheet as tag-sheet', () => {
    const rows: string[][] = [
      ['Campanha', 'Anúncio', 'Formato', 'Criativo', 'DV Tag Javascript', 'DV Tag - 1x1', 'DV 1x1 Tag - Video'],
      ['Pepsi_uefa', 'LABM_Display', '728x90', 'MEALS', '<script src="https://cdn.doubleverify.com/dvtp_src.js#cmp=DV1"></script>', '', '<img src="https://tps.doubleverify.com/v.gif">'],
    ];
    const r = detectDocType(rows);
    expect(r.type).toBe('tag-sheet');
  });

  it('classifies a DISPLAY/VIDEO TAGS sheet as tag-sheet', () => {
    const rows: string[][] = [
      ['Campanha', 'Anúncio', 'Formato', 'Criativo', 'DISPLAY TAGS (Use on Display Placements Only)', '', 'VIDEO TAGS (Use on Video Placements Only)'],
      ['Linha criativa: E2E'],
      ['gatorade_aware', 'lab_display', 'Standard IAB - Display 300x600', '', '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>', '', '<img src="https://tps.doubleverify.com/v.gif">'],
    ];
    expect(detectDocType(rows).type).toBe('tag-sheet');
  });

  it('rejects a naming-only taxonomy (ad names + landing URLs, no tags)', () => {
    const rows: string[][] = [
      ['Veículo', 'Pilar', 'Campanha', 'Conjunto de Anuncios', 'Anuncios', 'Url Parametrizada'],
      ['Hypr', 'Awareness', 'id_hypr', 'in-market_br', 'q3_video_lanc', 'https://www.audi.com.br/pt/models/q3?utm_source=hypr'],
    ];
    const r = detectDocType(rows);
    expect(r.type).toBe('naming-only');
    expect(r.message).toBeTruthy();
  });

  it('rejects a naming-only sheet with a preamble and Nome do anúncio header', () => {
    const rows: string[][] = [
      ['', 'TAXONOMIA - AON PERU - HYPR'],
      ['', 'Campanha:', '2026_latam_pe_elx'],
      ['', 'Nome do anúncio e URL´s', '2026_latam_pe_elx_160x600', '', 'https://www.electrolux.com.pe?utm_source=hypr'],
    ];
    expect(detectDocType(rows).type).toBe('naming-only');
  });

  it('returns unknown for an empty sheet', () => {
    expect(detectDocType([]).type).toBe('unknown');
    expect(detectDocType([['', ''], ['', '']]).type).toBe('unknown');
  });
});
