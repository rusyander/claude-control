import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeRuleFile } from '@claude-control/contracts/rule-format';
import { AppStore } from '../lib/app-store.ts';
import { readRules, saveRule, deleteRule, parseRules } from './rules.ts';

/**
 * Тесты правил. CLAUDE.md — это markdown, который читает сам Claude, а правила
 * в нём — разделы «## ПРАВИЛО: …». Приложение разбирает файл на отдельные
 * правила и собирает обратно так, чтобы файл остался нормальным markdown.
 * Здесь закрепляем главное: разбор по маркеру, стабильный id из заголовка
 * (кириллица транслитерируется — иначе id был бы пустым), сохранение/удаление
 * и то, что выключенное правило не теряется, а уезжает в раздел «Отключённые».
 *
 * Каждый тест работает с временными файлами и убирает их за собой. В настоящий
 * ~/.claude ничего не пишется: и CLAUDE.md, и хранилище состояния — во temp.
 */
describe('rules', () => {
  let dir: string;
  let claudeMdPath: string;
  let store: AppStore;

  // Реальное содержимое CLAUDE.md: преамбула (заголовок первого уровня +
  // абзац — она не должна попасть в правила) и два правила с маркером.
  const claudeMd = [
    '# Личные правила',
    '',
    'Вводный текст перед правилами — это преамбула, не правило.',
    '',
    '## ПРАВИЛО: Мой заголовок',
    '',
    'Тело первого правила.',
    'Вторая строка тела.',
    '',
    '## ПРАВИЛО: Второе правило',
    '',
    'Тело второго правила.',
    '',
  ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rules-'));
    claudeMdPath = join(dir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, claudeMd);
    // Хранилище состояния приложения (отметки «выключено», группы) — реальное,
    // но в отдельном временном каталоге, чтобы не трогать настоящие данные.
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('чтение правил', () => {
    it('находит все правила по маркеру «## ПРАВИЛО:»', () => {
      const rules = readRules(claudeMdPath, store);
      expect(rules).toHaveLength(2);
    });

    it('заголовок отдаётся без префикса «ПРАВИЛО:»', () => {
      const rules = readRules(claudeMdPath, store);
      expect(rules[0]?.title).toBe('Мой заголовок');
      expect(rules[1]?.title).toBe('Второе правило');
    });

    it('тело правила собирается из строк под заголовком', () => {
      const rules = readRules(claudeMdPath, store);
      expect(rules[0]?.body).toBe('Тело первого правила.\nВторая строка тела.');
    });

    it('порядок правил сохраняется как в файле', () => {
      const rules = readRules(claudeMdPath, store);
      expect(rules.map((r) => r.order)).toEqual([0, 1]);
    });

    it('свежепрочитанное правило считается включённым', () => {
      const rules = readRules(claudeMdPath, store);
      expect(rules.every((r) => r.isEnabled)).toBe(true);
    });
  });

  describe('slug из заголовка (транслитерация кириллицы)', () => {
    it('id — это транслитерированный слаг заголовка, а не пустая строка', () => {
      const rules = readRules(claudeMdPath, store);
      // «Мой заголовок» → moy zagolovok → moy-zagolovok.
      expect(rules[0]?.id).toBe('moy-zagolovok');
      // «Второе правило» → vtoroe pravilo → vtoroe-pravilo.
      expect(rules[1]?.id).toBe('vtoroe-pravilo');
    });

    it('id состоит только из латиницы, цифр и дефисов', () => {
      const rules = readRules(claudeMdPath, store);
      for (const rule of rules) {
        expect(rule.id).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it('одинаковые заголовки получают разные id (суффикс), чтобы не слиплись', () => {
      // Два правила с одним заголовком: без разведения id правка/удаление
      // затрагивали бы оба сразу.
      const withDupes = [
        '## ПРАВИЛО: Дубль',
        '',
        'Первое.',
        '',
        '## ПРАВИЛО: Дубль',
        '',
        'Второе.',
        '',
      ].join('\n');
      writeFileSync(claudeMdPath, withDupes);
      const rules = readRules(claudeMdPath, store);
      expect(rules[0]?.id).toBe('dubl');
      expect(rules[1]?.id).toBe('dubl-2');
    });
  });

  describe('сохранение правила', () => {
    it('новое правило (пустой id) дописывается в файл', () => {
      saveRule(
        claudeMdPath,
        '',
        { title: 'Третье правило', body: 'Тело третьего.', isEnabled: true, groupIds: [] },
        store,
      );
      const rules = readRules(claudeMdPath, store);
      expect(rules).toHaveLength(3);
      const added = rules.find((r) => r.title === 'Третье правило');
      expect(added?.id).toBe('trete-pravilo');
      expect(added?.body).toBe('Тело третьего.');
    });

    it('файл после сохранения остаётся markdown с маркером «## ПРАВИЛО:»', () => {
      saveRule(
        claudeMdPath,
        '',
        { title: 'Ещё правило', body: 'Текст.', isEnabled: true, groupIds: [] },
        store,
      );
      const content = readFileSync(claudeMdPath, 'utf8');
      expect(content).toContain('## ПРАВИЛО: Ещё правило');
      // Преамбула не потерялась при пересборке файла.
      expect(content).toContain('# Личные правила');
    });

    it('правка существующего правила по id меняет его тело, не плодит новое', () => {
      saveRule(
        claudeMdPath,
        'moy-zagolovok',
        { title: 'Мой заголовок', body: 'Новое тело.', isEnabled: true, groupIds: [] },
        store,
      );
      const rules = readRules(claudeMdPath, store);
      expect(rules).toHaveLength(2);
      expect(rules.find((r) => r.id === 'moy-zagolovok')?.body).toBe('Новое тело.');
    });
  });

  describe('удаление правила', () => {
    it('удаляет правило по id, остальные остаются', () => {
      deleteRule(claudeMdPath, 'moy-zagolovok', store);
      const rules = readRules(claudeMdPath, store);
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('vtoroe-pravilo');
    });

    it('текст удалённого правила исчезает из файла', () => {
      deleteRule(claudeMdPath, 'moy-zagolovok', store);
      const content = readFileSync(claudeMdPath, 'utf8');
      expect(content).not.toContain('Мой заголовок');
      expect(content).not.toContain('Тело первого правила.');
    });
  });

  describe('выключенное правило уезжает в раздел «Отключённые»', () => {
    it('правило, помеченное выключенным через store, попадает в служебный раздел', () => {
      // Выключение хранится в store, а не удалением из файла: текст правила
      // должен сохраниться. Помечаем первое правило выключенным…
      store.setEnabled('rule', 'moy-zagolovok', false);
      // …и заставляем файл пересобраться (удаление несуществующего id просто
      // перезаписывает файл сериализованными правилами).
      deleteRule(claudeMdPath, 'нет-такого', store);

      const content = readFileSync(claudeMdPath, 'utf8');
      // Появился служебный раздел с выключенными правилами.
      expect(content).toContain('## Отключённые правила (Claude Control)');
      // Выключенное правило перенесено туда как подраздел «### <заголовок>»,
      // а не как активное «## ПРАВИЛО:». Текст при этом не потерян.
      expect(content).toContain('### Мой заголовок');
      expect(content).toContain('Тело первого правила.');
      expect(content).not.toContain('## ПРАВИЛО: Мой заголовок');
      // Включённое правило осталось активным.
      expect(content).toContain('## ПРАВИЛО: Второе правило');
    });

    it('выключенное правило после перечитывания помечено isEnabled=false', () => {
      store.setEnabled('rule', 'moy-zagolovok', false);
      const rules = readRules(claudeMdPath, store);
      expect(rules.find((r) => r.id === 'moy-zagolovok')?.isEnabled).toBe(false);
      expect(rules.find((r) => r.id === 'vtoroe-pravilo')?.isEnabled).toBe(true);
    });
  });

  /**
   * Границы формата заголовка. Живой CLAUDE.md чаще всего размечен обычными
   * `## ` разделами — они правилами не являются и остаются в преамбуле как
   * есть; страница объясняет «0 правил» счётчиком таких разделов, поэтому
   * разбор и `summarizeRuleFile` из contracts/rule-format обязаны сходиться.
   */
  describe('границы разбора заголовка', () => {
    const parse = (md: string) => parseRules(md, 'global', store);

    it('обычные «## » разделы — не правила; файл целиком остаётся преамбулой', () => {
      const md = '# Личные правила\n\n## Язык\n\nПо-русски.\n\n## Git\n\nПо просьбе.\n';
      const parsed = parse(md);
      expect(parsed.rules).toHaveLength(0);
      expect(parsed.preamble).toBe(md.trimEnd());
      expect(summarizeRuleFile(md)).toMatchObject({ ruleHeadings: 0, plainSections: 2 });
    });

    it('смешанный файл: обычный раздел до правила — преамбула, после — часть тела', () => {
      const md = '## Обзор\n\nвводная\n\n## ПРАВИЛО: Одно\n\nтело\n\n## Ещё раздел\n\nхвост\n';
      const parsed = parse(md);
      expect(parsed.rules).toHaveLength(1);
      expect(parsed.preamble).toBe('## Обзор\n\nвводная');
      expect(parsed.rules[0]?.body).toBe('тело\n\n## Ещё раздел\n\nхвост');
      expect(summarizeRuleFile(md).ruleHeadings).toBe(parsed.rules.length);
    });

    it('слово «правило» в любом регистре и хвостовые пробелы — то же правило', () => {
      const parsed = parse('## Правило: Строчными  \n\nа\n\n##   ПРАВИЛО:   Хвост   \n\nб\n');
      expect(parsed.rules.map((rule) => rule.title)).toEqual(['Строчными', 'Хвост']);
    });

    it('без двоеточия, слитно с ## или на третьем уровне — не правило', () => {
      const md = '## ПРАВИЛО Без двоеточия\n\n##ПРАВИЛО: Слитно\n\n### ПРАВИЛО: Глубже\n';
      expect(parse(md).rules).toHaveLength(0);
      expect(summarizeRuleFile(md)).toMatchObject({ ruleHeadings: 0, plainSections: 1 });
    });

    it('пустой файл — ни правил, ни преамбулы', () => {
      expect(parse('')).toEqual({ preamble: '', rules: [] });
      expect(summarizeRuleFile('').hasContent).toBe(false);
    });

    it('CRLF-файл разбирается как LF: тела без \\r', () => {
      const parsed = parse('## ПРАВИЛО: Один\r\n\r\nтело\r\n\r\n## ПРАВИЛО: Два\r\n\r\nещё\r\n');
      expect(parsed.rules.map((rule) => rule.body)).toEqual(['тело', 'ещё']);
    });
  });
});
