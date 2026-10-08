import { describe, expect, it } from 'vitest';
import type { DiscoveredGroup } from '@agentdeck/contracts';
import type { GroupListItem } from '@entities/Group';
import { buildSections } from './sections';
import { projectPathOf } from './projectPathOf';
import { foundInOf } from './foundInOf';
import { sourceLabel } from './sourceLabel';
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

function found(key: string, status: DiscoveredGroup['status']): DiscoveredGroup {
  return {
    key,
    name: key,
    when: '',
    why: '',
    foundIn: 'c:/work/shop',
    usedIn: [],
    members: [],
    steps: [],
    inventoryHash: 'h',
    status,
  };
}

describe('buildSections', () => {
  it('группа без области — глобальная (записи до областей)', () => {
    const sections = buildSections([group('old')], undefined);
    expect(sections.global.map((card) => card.group.id)).toEqual(['old']);
    expect(sections.project).toEqual([]);
  });

  it('глобальная копия и живой оригинал — одна карточка, оригинала среди проектных нет', () => {
    const origin = group('shop', { scope: PROJECT, order: 1 });
    const copy = group('shop-global', {
      order: 0,
      origin: { scope: PROJECT, groupId: 'shop', hash: 'x', copiedAt: 'now' },
    });
    const sections = buildSections([origin, copy, group('solo', { scope: PROJECT })], undefined);
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
    const sections = buildSections([origin, qwen], undefined);
    expect(sections.global).toEqual([{ group: qwen }]);
    expect(sections.project.map((card) => card.group.id)).toEqual(['shop']);
  });

  it('оригинал удалён — копия остаётся простой глобальной карточкой', () => {
    const copy = group('copy', {
      origin: { scope: PROJECT, groupId: 'gone', hash: 'x', copiedAt: 'now' },
    });
    expect(buildSections([copy], undefined).global).toEqual([{ group: copy }]);
  });

  it('копия удалена — оригинал снова простая проектная карточка', () => {
    const origin = group('shop', { scope: PROJECT });
    expect(buildSections([origin], undefined).project).toEqual([{ group: origin }]);
  });

  it('порядок карточек — по order, а не по порядку ответа', () => {
    const sections = buildSections([group('b', { order: 2 }), group('a', { order: 1 })], undefined);
    expect(sections.global.map((card) => card.group.id)).toEqual(['a', 'b']);
  });

  it('в «Найдено» только ещё не импортированное', () => {
    const discovery = {
      groups: [found('a', 'new'), found('b', 'imported'), found('c', 'copied')],
      sources: [],
      running: false,
    };
    expect(buildSections([], discovery).discovered.map((item) => item.key)).toEqual(['a']);
  });
});

describe('foundInOf / projectPathOf / sourceLabel', () => {
  it('у копии «Найдено в» — проект оригинала, у ручной группы — ничего', () => {
    const copy = group('c', { origin: { scope: PROJECT, groupId: 'o', hash: 'x', copiedAt: 'n' } });
    expect(foundInOf(copy)).toBe('c:/work/shop');
    expect(projectPathOf(copy)).toBeUndefined();
    expect(foundInOf(group('manual'))).toBeUndefined();
    expect(foundInOf(group('p', { scope: PROJECT }))).toBe('c:/work/shop');
  });

  it('источник провайдера и проекта различаются', () => {
    expect(sourceLabel('provider:claude')).toEqual({ kind: 'provider', name: 'claude' });
    expect(sourceLabel('c:/work/shop')).toEqual({ kind: 'project', name: 'c:/work/shop' });
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
  const sections = buildSections([origin, copy, solo, plain], undefined);

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
