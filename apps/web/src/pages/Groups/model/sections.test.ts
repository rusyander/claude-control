import { describe, expect, it } from 'vitest';
import type { GroupListItem } from '@entities/Group';
import { buildSections } from './sections';
import { cardOf } from './cardOf';

function group(id: string, patch: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order: 0,
    ...patch,
  };
}

const PROJECT = { kind: 'project' as const, path: 'c:/work/shop', provider: 'claude' };

describe('buildSections', () => {
  it('группа без области — глобальная (записи до областей)', () => {
    const sections = buildSections([group('old')]);
    expect(sections.global.map((card) => card.group.id)).toEqual(['old']);
    expect(sections.project).toEqual([]);
  });

  it('глобальная копия и живой оригинал — одна карточка, оригинала среди проектных нет', () => {
    const origin = group('shop', { scope: PROJECT, order: 1 });
    const copy = group('shop-global', {
      order: 0,
      origin: { scope: PROJECT, groupId: 'shop', hash: 'x', copiedAt: 'now' },
    });
    const sections = buildSections([origin, copy, group('solo', { scope: PROJECT })]);
    expect(sections.global).toEqual([{ group: copy, pair: origin }]);
    expect(sections.project.map((card) => card.group.id)).toEqual(['solo']);
  });

  it('копия для другой CLI — своя карточка, не пара: оригинал остаётся проектной (F-40)', () => {
    const origin = group('shop', { scope: PROJECT, order: 1 });
    const qwen = group('shop-qwen', {
      order: 0,
      scope: { kind: 'global', provider: 'qwen' },
      origin: { scope: PROJECT, groupId: 'shop', hash: 'x', copiedAt: 'now' },
    });
    const sections = buildSections([origin, qwen]);
    expect(sections.global).toEqual([{ group: qwen }]);
    expect(sections.project.map((card) => card.group.id)).toEqual(['shop']);
  });

  it('оригинал удалён — копия остаётся простой глобальной карточкой', () => {
    const copy = group('copy', {
      origin: { scope: PROJECT, groupId: 'gone', hash: 'x', copiedAt: 'now' },
    });
    expect(buildSections([copy]).global).toEqual([{ group: copy }]);
  });

  it('копия удалена — оригинал снова простая проектная карточка', () => {
    const origin = group('shop', { scope: PROJECT });
    expect(buildSections([origin]).project).toEqual([{ group: origin }]);
  });

  it('порядок карточек — по order, а не по порядку ответа', () => {
    const sections = buildSections([group('b', { order: 2 }), group('a', { order: 1 })]);
    expect(sections.global.map((card) => card.group.id)).toEqual(['a', 'b']);
  });
});

// Ревью 28.09 F-80: фокус агента на проектной группе открывал вкладку памяти
// («Глобальные»), где карточки нет.
describe('cardOf — где на странице карточка группы', () => {
  const origin = group('shop', { scope: PROJECT, order: 1 });
  const copy = group('copy', {
    origin: { scope: PROJECT, groupId: 'shop', hash: 'x', copiedAt: 'now' },
  });
  const solo = group('solo', { scope: PROJECT });
  const plain = group('plain');
  const sections = buildSections([origin, copy, solo, plain]);

  it('проектная без пары — вкладка проектных, карточка её же', () => {
    expect(cardOf(sections, 'solo')).toEqual({ tab: 'project', cardId: 'solo' });
  });

  it('глобальная — вкладка глобальных', () => {
    expect(cardOf(sections, 'plain')).toEqual({ tab: 'global', cardId: 'plain' });
  });

  it('проектная половина пары — карточка глобальной копии на «Глобальных»', () => {
    expect(cardOf(sections, 'shop')).toEqual({ tab: 'global', cardId: 'copy' });
    expect(cardOf(sections, 'copy')).toEqual({ tab: 'global', cardId: 'copy' });
  });

  it('неизвестная группа — места нет', () => {
    expect(cardOf(sections, 'nope')).toBeUndefined();
  });
});
