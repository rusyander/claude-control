import { describe, it, expect } from 'vitest';
import {
  isPlainSectionHeading,
  isRuleHeading,
  summarizeRuleFile,
  DISABLED_SECTION,
} from '@claude-control/contracts/rule-format';
import { resolveRulesEmptyState } from './rulesEmptyState';

/**
 * Пустота раздела «Правила» объясняется по самому файлу, и объяснение обязано
 * совпадать с тем, что сервер сочтёт правилом: одна лишняя строка в счётчике —
 * и подсказка «в файле 3 раздела» сама станет ложью. Поэтому здесь закреплены
 * границы формата (регистр, пробелы, глубина заголовка, двоеточие) и решение
 * «какую заглушку показывать».
 */

describe('rule-format: что считается заголовком правила', () => {
  it('«## ПРАВИЛО: …» — правило; слово в любом регистре', () => {
    expect(isRuleHeading('## ПРАВИЛО: Отвечать по-русски')).toBe(true);
    expect(isRuleHeading('## Правило: строчными')).toBe(true);
    expect(isRuleHeading('## правило: совсем строчными')).toBe(true);
  });

  it('лишние и хвостовые пробелы заголовку не мешают', () => {
    expect(isRuleHeading('##   ПРАВИЛО:   Хвост   ')).toBe(true);
  });

  it('без двоеточия, слитно с ## или на третьем уровне — не правило', () => {
    expect(isRuleHeading('## ПРАВИЛО Без двоеточия')).toBe(false);
    expect(isRuleHeading('##ПРАВИЛО: Слитно')).toBe(false);
    expect(isRuleHeading('### ПРАВИЛО: Глубже')).toBe(false);
  });

  it('обычный раздел — любой «## …», кроме правила и служебного раздела выключенных', () => {
    expect(isPlainSectionHeading('## Обзор')).toBe(true);
    expect(isPlainSectionHeading('## ПРАВИЛО Без двоеточия')).toBe(true);
    expect(isPlainSectionHeading('## ПРАВИЛО: Правило')).toBe(false);
    expect(isPlainSectionHeading(DISABLED_SECTION)).toBe(false);
    expect(isPlainSectionHeading('### Подраздел')).toBe(false);
    expect(isPlainSectionHeading('##Слитно')).toBe(false);
    expect(isPlainSectionHeading('## ')).toBe(false);
  });
});

describe('summarizeRuleFile', () => {
  it('пустой файл и файл из пробелов — без содержимого', () => {
    expect(summarizeRuleFile('')).toEqual({ hasContent: false, ruleHeadings: 0, plainSections: 0 });
    expect(summarizeRuleFile('  \n\n\t\n')).toEqual({
      hasContent: false,
      ruleHeadings: 0,
      plainSections: 0,
    });
  });

  it('файл из обычных разделов: правил 0, разделы посчитаны', () => {
    const md = ['# Личные правила', '', '## Язык', 'текст', '## Проверка', '## Git', ''].join('\n');
    expect(summarizeRuleFile(md)).toEqual({ hasContent: true, ruleHeadings: 0, plainSections: 3 });
  });

  it('смешанный файл: правила и обычные разделы считаются раздельно', () => {
    const md = [
      '## Обзор',
      '',
      '## ПРАВИЛО: Одно',
      'тело',
      '',
      '## Ещё раздел',
      '## правило: два',
    ].join('\n');
    expect(summarizeRuleFile(md)).toEqual({ hasContent: true, ruleHeadings: 2, plainSections: 2 });
  });

  it('служебный раздел выключенных и его «### …» в счёт разделов не идут', () => {
    const md = [
      DISABLED_SECTION,
      '',
      'Правила ниже выключены.',
      '',
      '### Выключенное',
      'тело',
    ].join('\n');
    expect(summarizeRuleFile(md)).toEqual({ hasContent: true, ruleHeadings: 0, plainSections: 0 });
  });

  it('CRLF-файл считается так же, как LF', () => {
    const md = '## Один\r\n\r\n## ПРАВИЛО: Два\r\nтело\r\n';
    expect(summarizeRuleFile(md)).toEqual({ hasContent: true, ruleHeadings: 1, plainSections: 1 });
  });

  it('текст без единого заголовка — содержимое есть, разделов нет', () => {
    expect(summarizeRuleFile('Просто абзац.\n')).toEqual({
      hasContent: true,
      ruleHeadings: 0,
      plainSections: 0,
    });
  });
});

describe('resolveRulesEmptyState', () => {
  it('файл не загружен или недоступен — обычная заглушка', () => {
    expect(resolveRulesEmptyState(undefined)).toEqual({ kind: 'blank', plainSections: 0 });
  });

  it('файла нет или он пуст — обычная заглушка', () => {
    expect(resolveRulesEmptyState('')).toEqual({ kind: 'blank', plainSections: 0 });
    expect(resolveRulesEmptyState('\n\n')).toEqual({ kind: 'blank', plainSections: 0 });
  });

  it('непустой файл без правил в формате панели — объясняющая заглушка со счётчиком', () => {
    expect(resolveRulesEmptyState('## Язык\n## Git\n')).toEqual({
      kind: 'unformatted',
      plainSections: 2,
    });
    // Разделов может и не быть — один абзац: объяснение всё равно нужно, счётчик 0.
    expect(resolveRulesEmptyState('Просто текст.')).toEqual({
      kind: 'unformatted',
      plainSections: 0,
    });
  });
});
