import { describe, expect, it } from 'vitest';
import type { LocalLayerFit } from '@agentdeck/contracts/local-models';
import { layerNotice } from './layerNotice';

const tooBig: LocalLayerFit = {
  tokens: 73_254,
  context: 65_536,
  limit: 61_440,
  fits: false,
  at: 1,
};

describe('предупреждение о слое прогона (L6, ревью B1)', () => {
  it('влезает или замера нет — молчит', () => {
    expect(layerNotice(undefined)).toBeUndefined();
    expect(layerNotice({ ...tooBig, fits: true })).toBeUndefined();
  });

  it('не влезает: числа замера и окно, которое его вмещает', () => {
    expect(layerNotice({ ...tooBig, fix: { context: 98_304 } })).toEqual({
      tokens: 73_254,
      context: 65_536,
      limit: 61_440,
      fix: { key: 'fixContext', context: 98_304 },
    });
  });

  it('нынешнее квантование такое окно не вынесет — действие называет квантование', () => {
    expect(layerNotice({ ...tooBig, fix: { context: 98_304, quant: 'IQ4_XS' } })?.fix).toEqual({
      key: 'fixQuant',
      context: 98_304,
      quant: 'IQ4_XS',
    });
  });

  it('окна под слой у модели нет — так и сказано', () => {
    expect(layerNotice(tooBig)?.fix).toEqual({ key: 'fixNone' });
  });
});
