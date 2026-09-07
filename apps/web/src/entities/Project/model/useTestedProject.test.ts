import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Project } from '@agentdeck/contracts';
import { mergeProjects, readStored, resolveSelected, writeStored } from './useTestedProject';

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
