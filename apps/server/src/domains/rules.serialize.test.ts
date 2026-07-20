import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRules, serializeRules, readRules, saveRule } from './rules.ts';
import { AppStore } from '../lib/app-store.ts';

/**
 * Разбор и сборка CLAUDE.md. Файл — обычный markdown, который читает сам Claude,
 * поэтому важно, чтобы round-trip (разобрать → собрать) не терял и не искажал
 * содержимое: преамбулу, тело правил, порядок.
 */
describe('rules parse/serialize', () => {
  let dir: string;
  let claudeMd: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rules-ser-'));
    claudeMd = join(dir, 'CLAUDE.md');
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    writeFileSync(
      join(dir, 'claude-control', 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseRules', () => {
    it('преамбула до первого правила сохраняется', () => {
      const md = ['# Заголовок', '', 'Вводный абзац.', '', '## ПРАВИЛО: одно', '', 'Тело.'].join(
        '\n',
      );
      const { preamble, rules } = parseRules(md, 'global', store);

      expect(preamble).toBe('# Заголовок\n\nВводный абзац.');
      expect(rules).toHaveLength(1);
      expect(rules[0]?.title).toBe('одно');
      expect(rules[0]?.body).toBe('Тело.');
    });

    it('снимает префикс «ПРАВИЛО:» из заголовка (регистронезависимо)', () => {
      const md = ['## правило: нижним регистром', '', 'Тело.'].join('\n');
      const { rules } = parseRules(md, 'global', store);
      expect(rules[0]?.title).toBe('нижним регистром');
    });

    it('порядок правил соответствует порядку в файле', () => {
      const md = [
        '## ПРАВИЛО: первое',
        '',
        'a',
        '',
        '## ПРАВИЛО: второе',
        '',
        'b',
        '',
        '## ПРАВИЛО: третье',
        '',
        'c',
      ].join('\n');
      const { rules } = parseRules(md, 'global', store);
      expect(rules.map((r) => r.title)).toEqual(['первое', 'второе', 'третье']);
      expect(rules.map((r) => r.order)).toEqual([0, 1, 2]);
    });
  });

  describe('serializeRules round-trip', () => {
    it('включённое правило пересобирается дословно', () => {
      const md = ['# Шапка', '', '## ПРАВИЛО: одно', '', 'Тело правила.'].join('\n');
      const { preamble, rules } = parseRules(md, 'global', store);

      const out = serializeRules(preamble, rules);
      expect(out).toContain('# Шапка');
      expect(out).toContain('## ПРАВИЛО: одно');
      expect(out).toContain('Тело правила.');

      // Повторный разбор даёт то же самое.
      const again = parseRules(out, 'global', store);
      expect(again.rules[0]?.title).toBe('одно');
      expect(again.rules[0]?.body).toBe('Тело правила.');
    });

    it('многострочное тело правила сохраняется целиком', () => {
      const body = 'Первая строка.\n\n- пункт 1\n- пункт 2\n\nПоследняя строка.';
      const md = ['## ПРАВИЛО: список', '', body].join('\n');

      const { preamble, rules } = parseRules(md, 'global', store);
      const restored = parseRules(serializeRules(preamble, rules), 'global', store);

      expect(restored.rules[0]?.body).toBe(body);
    });

    /**
     * BUG (см. .agent/tmp/audit-config.md → BUG-5). Тело правила может содержать
     * собственные markdown-подзаголовки (`##`/`###`). Граница правила — только
     * маркер «## ПРАВИЛО:», поэтому разметка в теле не должна дробить правило.
     */
    it('markdown-подзаголовки внутри тела правила не рвут его (BUG-5)', () => {
      const body = [
        'Вступление.',
        '',
        '## Раздел тела',
        '',
        'Текст.',
        '',
        '### Подраздел',
        '',
        'Ещё.',
      ].join('\n');
      const md = ['## ПРАВИЛО: со разметкой', '', body].join('\n');

      const { preamble, rules } = parseRules(md, 'global', store);
      // Одно правило, а не несколько, разбитых по ## / ###.
      expect(rules).toHaveLength(1);
      expect(rules[0]?.title).toBe('со разметкой');
      expect(rules[0]?.body).toBe(body);

      // Round-trip сохраняет тело целиком.
      const restored = parseRules(serializeRules(preamble, rules), 'global', store);
      expect(restored.rules).toHaveLength(1);
      expect(restored.rules[0]?.body).toBe(body);
    });

    /**
     * BUG (см. .agent/tmp/audit-config.md → BUG-4). Парсер считает КАЖДЫЙ
     * заголовок второго уровня правилом, а сборка добавляет всем префикс
     * «ПРАВИЛО: ». Обычная секция вроде «## Обзор» после любой правки файла
     * превращается в «## ПРАВИЛО: Обзор» — тихая мутация исходного markdown.
     * Тест фиксирует ЖЕЛАЕМОЕ поведение и включится после фикса.
     */
    it('обычный h2-заголовок (не ПРАВИЛО) не обрастает префиксом (BUG-4)', () => {
      const md = ['## Обзор', '', 'Просто раздел.', '', '## ПРАВИЛО: настоящее', '', 'Тело.'].join(
        '\n',
      );
      const { preamble, rules } = parseRules(md, 'global', store);
      const out = serializeRules(preamble, rules);

      expect(out).toContain('## Обзор');
      expect(out).not.toContain('## ПРАВИЛО: Обзор');
    });

    it('round-trip через readRules/saveRule не мутирует чужой h2 «Обзор» (BUG-4)', () => {
      writeFileSync(
        claudeMd,
        ['## Обзор', '', 'Просто раздел.', '', '## ПРАВИЛО: настоящее', '', 'Тело.'].join('\n'),
      );
      // Обычная секция правилом не считается, поэтому в списке правил её нет.
      expect(readRules(claudeMd, store).map((r) => r.title)).toEqual(['настоящее']);

      const real = readRules(claudeMd, store).find((r) => r.title === 'настоящее')!;
      saveRule(claudeMd, real.id, { ...real, body: 'Изменено.' }, store);

      const after = readFileSync(claudeMd, 'utf8');
      // Секция «## Обзор» осталась собой, а не замаскировалась под правило.
      expect(after).toContain('## Обзор');
      expect(after).not.toContain('## ПРАВИЛО: Обзор');
      expect(after).toContain('## ПРАВИЛО: настоящее');
      expect(after).toContain('Изменено.');
    });
  });

  describe('выключенные правила в служебном разделе', () => {
    it('выключенное правило пишется в служебный раздел и читается обратно', () => {
      const rules = parseRules(
        ['## ПРАВИЛО: живое', '', 'Живой текст.'].join('\n'),
        'global',
        store,
      ).rules;
      const off = [{ ...rules[0]!, isEnabled: false }];

      const out = serializeRules('# Шапка', off);
      expect(out).toContain('## Отключённые правила (Claude Control)');
      expect(out).toContain('### живое');

      const restored = parseRules(out, 'global', store);
      const revived = restored.rules.find((r) => r.title === 'живое');
      expect(revived?.isEnabled).toBe(false);
      expect(revived?.body).toBe('Живой текст.');
    });
  });
});
