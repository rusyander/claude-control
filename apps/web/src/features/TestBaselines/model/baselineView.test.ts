import { describe, it, expect } from 'vitest';
import type { ProjectTestBaseline } from '@agentdeck/contracts';
import { baselineTone, isOverThreshold, pickPoint, ratioPercent } from './baselineView';

const point = (over: Partial<ProjectTestBaseline>): ProjectTestBaseline => ({
  pointId: 'gui-001',
  caseId: 'gui-001',
  file: '.agent/tests/baselines/gui-001/gui-001.png',
  status: 'match',
  ...over,
});

describe('baselineTone', () => {
  it('каждому состоянию свой цвет, и «эталон только что заведён» не тревога', () => {
    expect(baselineTone('match')).toBe('success');
    expect(baselineTone('diff')).toBe('warning');
    expect(baselineTone('new')).toBe('neutral');
    expect(baselineTone('error')).toBe('danger');
  });
});

describe('pickPoint', () => {
  const points = [point({ pointId: 'a' }), point({ pointId: 'b' })];

  it('находит выбранную точку', () => {
    expect(pickPoint(points, 'b')?.pointId).toBe('b');
  });

  it('пропавшая точка заменяется первой, пустой список — ничем', () => {
    expect(pickPoint(points, 'нет')?.pointId).toBe('a');
    expect(pickPoint([], 'a')).toBeUndefined();
  });
});

describe('ratioPercent', () => {
  it('показывает сотые доли процента', () => {
    expect(ratioPercent(0.0001)).toBe('0.01%');
    expect(ratioPercent(0.1234)).toBe('12.34%');
  });

  it('нечего показывать — пустая строка, а не «0%»', () => {
    expect(ratioPercent(undefined)).toBe('');
    expect(ratioPercent(Number.NaN)).toBe('');
  });
});

describe('isOverThreshold', () => {
  it('сравнивает с порогом кейса', () => {
    expect(isOverThreshold(point({ diffRatio: 0.02, maxDiffRatio: 0.01 }))).toBe(true);
    expect(isOverThreshold(point({ diffRatio: 0.005, maxDiffRatio: 0.01 }))).toBe(false);
  });

  it('без порога или без расхождения приговора нет', () => {
    expect(isOverThreshold(point({ diffRatio: 0.5 }))).toBe(false);
    expect(isOverThreshold(point({ maxDiffRatio: 0.01 }))).toBe(false);
  });
});
