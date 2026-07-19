import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRules, saveRule } from './rules.ts';
import { AppStore } from '../lib/app-store.ts';

/**
 * Регрессия настоящей потери данных, найденной на живом CLAUDE.md.
 *
 * Выключенное правило уезжает в служебный раздел файла, и панель обещает, что
 * текст сохранён. Но разбор пропускал содержимое этого раздела целиком:
 * правило исчезало из списка, а сборка файла идёт из того же списка — значит
 * следующая перезапись стирала правило насовсем.
 *
 * Порядок такой: выключить → перечитать → перезаписать по другому поводу →
 * убедиться, что текст на месте и правило можно включить обратно.
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
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    writeFileSync(claudeMd, ORIGINAL);
    store = new AppStore(join(dir, 'claude-control'));
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

  it('текст выключенного правила сохраняется дословно', () => {
    disable('pervoe');

    const rule = readRules(claudeMd, store).find((item) => item.id === 'pervoe');
    expect(rule?.body).toBe('Текст первого правила.');
  });

  it('ГЛАВНОЕ: следующая перезапись файла не стирает выключенное правило', () => {
    disable('pervoe');

    // Любая посторонняя правка — здесь сохранение второго правила.
    const second = readRules(claudeMd, store).find((item) => item.id === 'vtoroe');
    saveRule(claudeMd, 'vtoroe', { ...second!, body: 'Изменённый текст.' }, store);

    const markdown = readFileSync(claudeMd, 'utf8');
    expect(markdown).toContain('Текст первого правила.');
    expect(readRules(claudeMd, store).map((rule) => rule.id)).toContain('pervoe');
  });

  it('правило включается обратно и возвращается в основной раздел', () => {
    disable('pervoe');

    // Так же, как это делает маршрут: состояние передаётся явно, потому что
    // при чтении оно определяется расположением правила в файле.
    store.setEnabled('rule', 'pervoe', true);
    const rule = readRules(claudeMd, store).find((item) => item.id === 'pervoe');
    saveRule(claudeMd, 'pervoe', { ...rule!, isEnabled: true }, store);

    const markdown = readFileSync(claudeMd, 'utf8');
    expect(markdown).toContain('## ПРАВИЛО: первое');
    expect(markdown).not.toContain('Отключённые правила');
    expect(readRules(claudeMd, store).find((item) => item.id === 'pervoe')?.isEnabled).toBe(true);
  });

  it('пояснение служебного раздела не прилипает к тексту правила', () => {
    disable('pervoe');

    const rule = readRules(claudeMd, store).find((item) => item.id === 'pervoe');
    expect(rule?.body).not.toMatch(/выключены в приложении/);
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
    // Оба текста на месте: ни один не съеден.
    expect(readFileSync(claudeMd, 'utf8')).toContain('Дубль с другим текстом.');
    expect(readFileSync(claudeMd, 'utf8')).toContain('Текст первого правила.');
  });
});
