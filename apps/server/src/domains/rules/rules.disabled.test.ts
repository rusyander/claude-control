import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRules, saveRule } from './rules.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';

/**
 * Выключение правила не равно удалению — регрессия настоящей потери данных,
 * найденной на живом CLAUDE.md (текст выключенного правила стирала следующая
 * перезапись файла).
 *
 * С F1 (решение владельца 27.09) выключенное правило в CLAUDE.md НЕ лежит вовсе:
 * его текст держит состояние панели. Порядок проверки прежний: выключить →
 * перечитать → перезаписать по другому поводу → убедиться, что текст цел и
 * правило включается обратно.
 */
describe('Выключенные правила не теряются', () => {
  let dir: string;
  let claudeMd: string;
  let store: AppStore;

  const ORIGINAL = [
    '# Правила',
    '',
    '## ПРАВИЛО: первое',
    '',
    'Текст первого правила.',
    '',
    '## ПРАВИЛО: второе',
    '',
    'Текст второго правила.',
    '',
  ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rules-off-'));
    claudeMd = join(dir, 'CLAUDE.md');
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    writeFileSync(claudeMd, ORIGINAL);
    store = new AppStore(join(dir, 'agentdeck'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Выключение так, как это делает маршрут: отметка плюс перезапись файла. */
  const disable = (id: string): void => {
    store.setEnabled('rule', id, false);
    const rule = readRules(claudeMd, store).find((item) => item.id === id);
    if (rule) saveRule(claudeMd, id, rule, store);
  };

  it('выключенное правило остаётся в списке', () => {
    disable('pervoe');

    const rules = readRules(claudeMd, store);
    expect(rules.map((rule) => rule.id)).toContain('pervoe');
    expect(rules.find((rule) => rule.id === 'pervoe')?.isEnabled).toBe(false);
  });

  it('F1: выключенного правила в CLAUDE.md нет — ни заголовка, ни текста', () => {
    disable('pervoe');

    const markdown = readFileSync(claudeMd, 'utf8');
    expect(markdown).not.toContain('первое');
    expect(markdown).not.toContain('Текст первого правила.');
    expect(markdown).not.toContain('Отключённые правила');
    expect(markdown).toBe('# Правила\n\n## ПРАВИЛО: второе\n\nТекст второго правила.\n');
  });

  it('F1: текст выключенного правила лежит в state.json дословно', () => {
    disable('pervoe');

    const onDisk = JSON.parse(readFileSync(join(dir, 'agentdeck', 'state.json'), 'utf8')) as {
      disabledRules?: Array<{ title: string; body: string }>;
    };
    expect(onDisk.disabledRules).toEqual([
      expect.objectContaining({ title: 'первое', body: 'Текст первого правила.' }),
    ]);
    const rule = readRules(claudeMd, store).find((item) => item.id === 'pervoe');
    expect(rule?.body).toBe('Текст первого правила.');
  });

  it('ГЛАВНОЕ: следующая перезапись файла не стирает выключенное правило', () => {
    disable('pervoe');

    // Любая посторонняя правка — здесь сохранение второго правила.
    const second = readRules(claudeMd, store).find((item) => item.id === 'vtoroe');
    saveRule(claudeMd, 'vtoroe', { ...second!, body: 'Изменённый текст.' }, store);

    const kept = readRules(claudeMd, store).find((rule) => rule.id === 'pervoe');
    expect(kept?.body).toBe('Текст первого правила.');
    expect(kept?.isEnabled).toBe(false);
    // Новое хранилище над тем же каталогом — то, что увидит панель после перезапуска.
    const reopened = new AppStore(join(dir, 'agentdeck'));
    expect(readRules(claudeMd, reopened).find((rule) => rule.id === 'pervoe')?.body).toBe(
      'Текст первого правила.',
    );
  });

  it('F2: включённое правило возвращается на прежнее место — файл байт в байт', () => {
    disable('pervoe');

    // Так же, как это делает маршрут: состояние передаётся явно.
    store.setEnabled('rule', 'pervoe', true);
    const rule = readRules(claudeMd, store).find((item) => item.id === 'pervoe');
    saveRule(claudeMd, 'pervoe', { ...rule!, isEnabled: true }, store);

    expect(readFileSync(claudeMd, 'utf8')).toBe(ORIGINAL);
    expect(store.getDisabledRules()).toEqual([]);
    expect(readRules(claudeMd, store).find((item) => item.id === 'pervoe')?.isEnabled).toBe(true);
  });

  it('одноимённые правила и после выключения различаются по id', () => {
    // Заголовки пишет человек, повторы в живом файле встречаются.
    writeFileSync(
      claudeMd,
      [ORIGINAL, '## ПРАВИЛО: первое', '', 'Дубль с другим текстом.', ''].join('\n'),
    );

    disable('pervoe');

    const rules = readRules(claudeMd, store);
    const sameTitle = rules.filter((rule) => rule.title === 'первое');
    expect(sameTitle).toHaveLength(2);
    expect(new Set(sameTitle.map((rule) => rule.id)).size).toBe(2);
    // Оба текста целы: один в файле, другой в состоянии панели.
    expect(readFileSync(claudeMd, 'utf8')).toContain('Дубль с другим текстом.');
    expect(sameTitle.map((rule) => rule.body)).toContain('Текст первого правила.');
  });
});
