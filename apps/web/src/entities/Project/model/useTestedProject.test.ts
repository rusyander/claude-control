import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Project } from '@agentdeck/contracts';
import { resolveSelected } from '../lib/resolveSelected';
import { mergeProjects } from '../lib/mergeProjects';
import { projectByPath } from '../lib/projectByPath';
import { readStored } from '../lib/readStored';
import { subscribeStored } from '../lib/subscribeStored';
import { writeStored } from '../lib/writeStored';

describe('projectByPath', () => {
  const projects = [
    { id: 'a', name: 'A', path: 'C:/work/agentdeck' },
    { id: 'b', name: 'B', path: 'C:/work/other' },
  ] as Project[];

  it('каталог агента находит проект, как бы ни были записаны регистр и слэши', () => {
    expect(projectByPath(projects, 'c:\\Work\\Other\\')?.id).toBe('b');
  });

  it('незнакомый каталог — ничего, а не первый попавшийся проект', () => {
    expect(projectByPath(projects, 'C:/work/agentdeck-copy')).toBeUndefined();
  });
});

describe('mergeProjects', () => {
  const registry = [{ id: 'r1', name: 'Реестр', path: 'C:/work/agentdeck' }] as Project[];

  it('вкладка, которой нет в реестре, дописывается в конец', () => {
    const merged = mergeProjects(registry, [
      { id: 'tab', name: 'Вкладка', path: 'C:/work/other' },
    ] as Project[]);
    expect(merged.map((item) => item.path)).toEqual(['C:/work/agentdeck', 'C:/work/other']);
  });

  it('тот же проект не задваивается — регистр пути не в счёт', () => {
    const merged = mergeProjects(registry, [
      { id: 'tab', name: 'Вкладка', path: 'c:/WORK/agentdeck' },
    ] as Project[]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('r1');
  });

  it('без вкладок список равен реестру', () => {
    expect(mergeProjects(registry, [])).toEqual(registry);
  });
});

describe('resolveSelected', () => {
  const projects = [{ id: 'agentdeck' }, { id: 'enterprise-platform' }] as Project[];

  it('запомненный проект остаётся выбранным', () => {
    expect(resolveSelected(projects, 'enterprise-platform')).toBe('enterprise-platform');
  });

  it('исчезнувший из реестра проект заменяется первым, а не пустым экраном', () => {
    expect(resolveSelected(projects, 'удалённый')).toBe('agentdeck');
    expect(resolveSelected(projects, '')).toBe('agentdeck');
  });

  it('пустой реестр выбор не сбрасывает — проекты ещё грузятся', () => {
    expect(resolveSelected([], 'enterprise-platform')).toBe('enterprise-platform');
  });

  it('пока реестр грузится, открытая вкладка не вытесняет запомненный проект', () => {
    const tabsOnly = [{ id: 'c:/work/tab' }] as Project[];
    expect(resolveSelected(tabsOnly, 'enterprise-platform', true)).toBe('enterprise-platform');
  });

  // Ревью 28.09 (F-194): упавший реестр тоже даёт список из одних вкладок, и
  // запомненный проект подменялся первой вкладкой до конца сессии — «Повторить»
  // его уже не возвращал.
  it('при упавшем реестре запомненный проект не вытесняется вкладкой', () => {
    const tabsOnly = [{ id: 'c:/work/tab' }] as Project[];
    expect(resolveSelected(tabsOnly, 'enterprise-platform', false, true)).toBe(
      'enterprise-platform',
    );
  });
});

/**
 * Память о выбранном проекте — удобство, а не условие работы раздела: в
 * приватном окне и при запрете на хранилище раздел обязан открываться, а не
 * падать белым экраном.
 */
const KEY = 'agentdeck:tests-project';

describe('память о выбранном проекте', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;

  const install = (store: Partial<Storage>): void => {
    (globalThis as { localStorage?: unknown }).localStorage = store;
  };

  beforeEach(() => {
    const data = new Map<string, string>();
    install({
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
  });

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it('записанное читается обратно', () => {
    expect(readStored()).toBe('');
    writeStored('agentdeck');
    expect(readStored()).toBe('agentdeck');
  });

  it('запрещённое хранилище не роняет раздел', () => {
    install({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readStored()).toBe('');
    expect(() => writeStored('x')).not.toThrow();
  });

  it('без хранилища вовсе память просто пуста', () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(readStored()).toBe('');
    expect(() => writeStored('x')).not.toThrow();
  });

  it('ключ хранения — тот же, по которому раздел ищет запомненное', () => {
    writeStored('enterprise-platform');
    expect(globalThis.localStorage.getItem(KEY)).toBe('enterprise-platform');
  });
});

// Ревью 28.09 F-95: окно агента читало проект при отрисовке, а выбор на /tests
// его не перерисовывал — подпись показывала A, агент получал B.
describe('подписка на выбранный проект', () => {
  it('запись будит подписчиков, отписка — перестаёт', () => {
    const seen: string[] = [];
    const stop = subscribeStored((id) => seen.push(id));
    writeStored('one');
    writeStored('two');
    stop();
    writeStored('three');
    expect(seen).toEqual(['one', 'two']);
  });
});
