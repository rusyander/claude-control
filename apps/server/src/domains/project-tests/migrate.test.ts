import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { groupIdFrom, migrateAllureTestOps, migrateTestRail } from './migrate.ts';
import { readGroups } from './store.ts';

/**
 * Переезд из чужой TMS. Проверяется главное отличие от обычного импорта: дерево
 * выгрузки становится деревом проекта — сюита группой, путь секции полем
 * `section`, — иначе сотни кейсов приезжают плоской простынёй.
 */
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const NOW = '2026-09-07T10:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function group(root: string, id: string) {
  return readGroups(root).find((item) => item.id === id);
}

describe('переезд из чужой TMS', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-migrate-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('TestRail: сюиты становятся группами, путь секции — полем section', () => {
    const result = migrateTestRail(root, fixture('testrail-export.csv'), { now: NOW });

    expect(result).toMatchObject({ read: 4, created: 4, matched: 0 });
    expect(result.groups.sort()).toEqual(['api', 'gui']);

    const gui = group(root, 'gui');
    expect(gui?.title).toBe('GUI');
    expect(gui?.cases.map((item) => item.title)).toEqual([
      'Открытие чата',
      'Отправка сообщения',
      'Экспорт разговора',
    ]);
    // `Чат > Основное` — это наш `Чат/Основное`, а не строка как есть.
    expect(gui?.cases[0]?.section).toBe('Чат/Основное');
    expect(gui?.cases[0]?.priority).toBe('high');
    expect(gui?.cases[1]?.priority).toBe('blocker');
    expect(gui?.cases[0]?.steps).toHaveLength(2);
    expect(gui?.cases[0]?.links?.[0]?.url).toBe('REQ-1');
    expect(group(root, 'api')?.cases).toHaveLength(1);
  });

  it('перенесённые кейсы человеческие и без выдуманного статуса', () => {
    migrateTestRail(root, fixture('testrail-export.csv'), { now: NOW });

    const cases = group(root, 'gui')?.cases ?? [];
    expect(cases.every((item) => item.source === 'human')).toBe(true);
    expect(cases.every((item) => item.status === 'unknown')).toBe(true);
  });

  it('повторный переезд обновляет те же кейсы, а не удваивает базу', () => {
    migrateTestRail(root, fixture('testrail-export.csv'), { now: NOW });
    const second = migrateTestRail(root, fixture('testrail-export.csv'), { now: NOW });

    expect(second).toMatchObject({ matched: 4, created: 0 });
    expect(group(root, 'gui')?.cases).toHaveLength(3);
  });

  it('Allure TestOps (JSON): шаги разворачиваются, метки и ссылки переносятся', () => {
    const result = migrateAllureTestOps(root, fixture('allure-testops.json'), { now: NOW });

    expect(result).toMatchObject({ format: 'allure', read: 2, created: 2 });
    expect(result.groups.sort()).toEqual(['api', 'gui']);

    const first = group(root, 'gui')?.cases[0];
    expect(first).toMatchObject({
      title: 'Открытие чата',
      purpose: 'Человек должен увидеть список разговоров',
      precondition: 'Панель открыта',
      expected: 'Видна переписка',
      section: 'Чат/Основное',
      tags: ['smoke', 'чат'],
      automation: { status: 'automated' },
    });
    // Вложенный шаг разворачивается в плоский список — как и у нас в файле.
    expect(first?.steps.map((step) => step.action)).toEqual([
      'Нажать «Чат»',
      'Выбрать разговор',
      'Проверить заголовок',
    ]);
    expect(first?.links?.[0]?.url).toBe('https://tracker/REQ-1');
    expect(group(root, 'api')?.cases[0]?.section).toBe('Служебное/Проверки');
  });

  it('TestOps принимает и голый массив, и обёртку постраничного ответа', () => {
    const result = migrateAllureTestOps(root, '[{"name":"Один","suite":"Смоук"}]', { now: NOW });

    expect(result.groups).toEqual(['smouk']);
    expect(group(root, 'smouk')?.cases[0]?.title).toBe('Один');
  });

  it('кейсы без сюиты уходят в группу-приёмник по умолчанию', () => {
    migrateAllureTestOps(root, '[{"name":"Один"},{"name":"Два"}]', {
      fallbackGroupId: 'legacy',
      now: NOW,
    });

    expect(group(root, 'legacy')?.cases).toHaveLength(2);
  });

  it('пустая и битая выгрузка — понятная ошибка, а не молчаливый ноль', () => {
    expect(() => migrateTestRail(root, 'совсем не таблица')).toThrow(/не разобралась/);
    expect(() => migrateAllureTestOps(root, '{ сломано')).toThrow(/не разобралась/);
    expect(() => migrateAllureTestOps(root, '[]')).toThrow(/не нашлось/);
  });

  it('имя сюиты превращается в допустимое имя файла группы', () => {
    expect(groupIdFrom('Мобильное приложение', 'x')).toBe('mobilnoe-prilozhenie');
    expect(groupIdFrom('!!!', 'fallback')).toBe('fallback');
    expect(groupIdFrom('', 'fallback')).toBe('fallback');
  });
});
