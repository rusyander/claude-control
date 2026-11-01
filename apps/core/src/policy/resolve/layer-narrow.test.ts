import { describe, expect, it } from 'vitest';
import { narrowLayer } from './layer-narrow.ts';

/**
 * Слой шага против правила маршрута: побеждает меньше слоя пользователя (хуки off<observe<on,
 * навыки off<on), каждое сужение названо; нет правила — слой шага как есть (R6).
 */

describe('narrowLayer: the narrower layer wins, named', () => {
  it('a route rule narrows hooks and skills; a wider rule never widens the step', () => {
    expect(narrowLayer({ hooks: 'on', skills: 'on' }, { hooks: 'observe', skills: 'off' })).toEqual(
      {
        layer: { hooks: 'observe', skills: 'off' },
        narrowed: ['hooks on → observe (route rule)', 'skills on → off (route rule)'],
      },
    );
    expect(narrowLayer({ hooks: 'observe', skills: 'off' }, { hooks: 'on', skills: 'on' })).toEqual(
      {
        layer: { hooks: 'observe', skills: 'off' },
        narrowed: [],
      },
    );
    expect(narrowLayer({ hooks: 'observe', skills: 'on' }, { hooks: 'off' })).toEqual({
      layer: { hooks: 'off', skills: 'on' },
      narrowed: ['hooks observe → off (route rule)'],
    });
  });

  it('no rule (no contour reader yet, R6): the step layer as is', () => {
    expect(narrowLayer({ hooks: 'on', skills: 'on' })).toEqual({
      layer: { hooks: 'on', skills: 'on' },
      narrowed: [],
    });
  });
});
