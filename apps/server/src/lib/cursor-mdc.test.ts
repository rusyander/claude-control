import { describe, it, expect } from 'vitest';
import { MdcFormatError, readMdcRule, splitMdc, writeMdcRule } from './cursor-mdc.ts';

/**
 * CURSOR-1: разбор и сборка файла правила `.mdc` (YAML-frontmatter + markdown).
 *
 * Проверяем обещанное: три задокументированных поля читаются во всех живых
 * формах; тело возвращается и записывается БЕЗ изменений; чужие ключи и
 * комментарии frontmatter переживают правку; пустое значение удаляет ключ, а не
 * пишет умолчание; непонятная форма — fail-closed (`MdcFormatError`).
 */
const RULE = `---
# правило фронтенда
description: Правила React-компонентов
globs: src/**/*.tsx, src/**/*.ts
alwaysApply: false
owner: team-fe
---
# Компоненты

Только функциональные.
`;

describe('cursor-mdc: чтение правила', () => {
  it('читает три поля frontmatter, тело и чужие ключи', () => {
    const rule = readMdcRule(RULE);
    expect(rule.fields).toEqual({
      description: 'Правила React-компонентов',
      globs: 'src/**/*.tsx, src/**/*.ts',
      alwaysApply: false,
    });
    expect(rule.body).toBe('# Компоненты\n\nТолько функциональные.\n');
    expect(rule.otherKeys).toEqual(['owner']);
  });

  it('частичный frontmatter: незаданные поля просто отсутствуют', () => {
    const rule = readMdcRule('---\nalwaysApply: true\n---\nтело\n');
    expect(rule.fields).toEqual({ alwaysApply: true });
    expect(rule.body).toBe('тело\n');
  });

  it('пустой frontmatter — валидное правило без полей', () => {
    const rule = readMdcRule('---\n---\nтолько тело\n');
    expect(rule.fields).toEqual({});
    expect(rule.body).toBe('только тело\n');
  });

  it('globs YAML-списком читается как строка через запятую', () => {
    const rule = readMdcRule('---\nglobs:\n  - a.ts\n  - b.ts\n---\nB');
    expect(rule.fields.globs).toBe('a.ts, b.ts');
  });

  it('CRLF и BOM не мешают разбору, тело сохраняет свои переводы строк', () => {
    const rule = readMdcRule('﻿---\r\ndescription: c\r\n---\r\nтело\r\n');
    expect(rule.fields.description).toBe('c');
    expect(rule.body).toBe('тело\r\n');
  });

  it('файл без frontmatter → no_frontmatter (Cursor такое правило не подключает)', () => {
    expect(() => readMdcRule('# просто markdown\n')).toThrowError(MdcFormatError);
    try {
      readMdcRule('# просто markdown\n');
    } catch (error) {
      expect((error as MdcFormatError).problem).toBe('no_frontmatter');
    }
  });

  it('незакрытый frontmatter тоже считается отсутствующим', () => {
    expect(splitMdc('---\ndescription: x\nтело без закрытия\n')).toBeUndefined();
    try {
      readMdcRule('---\ndescription: x\nтело без закрытия\n');
    } catch (error) {
      expect((error as MdcFormatError).problem).toBe('no_frontmatter');
    }
  });

  it('битый YAML и неожиданные типы полей → malformed (fail-closed)', () => {
    for (const text of [
      '---\ndescription: [неожиданно\n---\nB',
      '---\n- список вместо отображения\n---\nB',
      '---\nalwaysApply: конечно\n---\nB',
      '---\ndescription: 42\n---\nB',
      '---\nglobs:\n  - 1\n---\nB',
    ]) {
      let problem: string | undefined;
      try {
        readMdcRule(text);
      } catch (error) {
        problem = (error as MdcFormatError).problem;
      }
      expect(problem, text).toBe('malformed');
    }
  });
});

describe('cursor-mdc: запись правила', () => {
  it('меняет только управляемые поля: комментарий, чужой ключ и тело целы', () => {
    const next = writeMdcRule(
      RULE,
      { description: 'Новое описание', globs: 'src/**/*.tsx, src/**/*.ts', alwaysApply: true },
      readMdcRule(RULE).body,
    );
    expect(next).toContain('# правило фронтенда');
    expect(next).toContain('owner: team-fe');
    expect(next).toContain('description: Новое описание');
    expect(next).toContain('alwaysApply: true');
    expect(readMdcRule(next).body).toBe('# Компоненты\n\nТолько функциональные.\n');
  });

  it('пустое значение УДАЛЯЕТ ключ, а не пишет умолчание', () => {
    const next = writeMdcRule(RULE, { description: '   ', globs: '' }, 'тело\n');
    expect(next).not.toContain('description:');
    expect(next).not.toContain('globs:');
    expect(next).not.toContain('alwaysApply:');
    // Чужой ключ при этом на месте.
    expect(next).toContain('owner: team-fe');
    expect(readMdcRule(next).fields).toEqual({});
  });

  it('удаление всех ключей оставляет пустой frontmatter, а не «{}»', () => {
    const next = writeMdcRule('---\ndescription: x\n---\nBODY\n', {}, 'BODY\n');
    expect(next).toBe('---\n---\nBODY\n');
    expect(next).not.toContain('{}');
  });

  it('новое правило собирается из пустоты в задокументированном порядке полей', () => {
    const next = writeMdcRule(
      '',
      { description: 'd', globs: '*.ts', alwaysApply: false },
      'тело\n',
    );
    expect(next).toBe('---\ndescription: d\nglobs: "*.ts"\nalwaysApply: false\n---\nтело\n');
  });

  it('неизменённый globs-список остаётся списком (форма записи не ломается)', () => {
    const source = '---\nglobs:\n  - a.ts\n  - b.ts\n---\nB';
    const rule = readMdcRule(source);
    expect(writeMdcRule(source, rule.fields, rule.body)).toBe(source);
  });

  it('тело пишется дословно: markdown с «---» внутри не рвёт файл', () => {
    const body = 'начало\n\n---\n\nконец\n';
    const next = writeMdcRule('', { description: 'd' }, body);
    expect(readMdcRule(next).body).toBe(body);
  });

  it('длинные значения не переносятся на следующую строку', () => {
    const globs = Array.from(
      { length: 20 },
      (_, i) => `src/very/long/path/segment-${i}/**/*.ts`,
    ).join(', ');
    const next = writeMdcRule('', { globs }, 'B');
    expect(readMdcRule(next).fields.globs).toBe(globs);
    expect(next.split('\n').filter((line) => line.startsWith('globs:'))).toHaveLength(1);
  });

  it('CRLF в теле нормализуется к LF (форму файла вернёт safe-io)', () => {
    const next = writeMdcRule('', { description: 'd' }, 'первая\r\nвторая\r\n');
    expect(next).toBe('---\ndescription: d\n---\nпервая\nвторая\n');
  });

  it('нераспознанный существующий frontmatter не переписывается вслепую', () => {
    expect(() => writeMdcRule('---\nalwaysApply: конечно\n---\nB', {}, 'B')).toThrowError(
      MdcFormatError,
    );
  });
});
