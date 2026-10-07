import { describe, expect, it } from 'vitest';
import { MdcFormatError } from './cursor-mdc.ts';
import { readQwenRule, splitPatterns, writeQwenRule } from './qwen-rule-md.ts';

describe('readQwenRule', () => {
  it('файл без frontmatter — постоянное правило, тело целиком, без пометки read-only', () => {
    const rule = readQwenRule('Всегда отвечай по-русски.\n');
    expect(rule).toEqual({ fields: {}, body: 'Всегда отвечай по-русски.\n', otherKeys: [] });
  });

  it('paths списком отдаётся строкой через запятую, description — как есть', () => {
    const rule = readQwenRule(
      '---\ndescription: React\npaths:\n  - src/**/*.tsx\n  - src/**/*.{ts,mts}\n---\nТело\n',
    );
    expect(rule.fields).toEqual({ description: 'React', globs: 'src/**/*.tsx, src/**/*.{ts,mts}' });
    expect(rule.body).toBe('Тело\n');
  });

  it('paths строкой тоже читается; чужие ключи названы', () => {
    const rule = readQwenRule('---\npaths: docs/**\nowner: team\n---\nx\n');
    expect(rule.fields).toEqual({ globs: 'docs/**' });
    expect(rule.otherKeys).toEqual(['owner']);
  });

  it('paths не строка и не список строк — malformed (fail-closed)', () => {
    expect(() => readQwenRule('---\npaths: 3\n---\nx\n')).toThrow(MdcFormatError);
    expect(() => readQwenRule('---\npaths:\n  - 1\n---\nx\n')).toThrow(MdcFormatError);
  });
});

describe('splitPatterns', () => {
  it('запятая внутри фигурных скобок шаблон не режет', () => {
    expect(splitPatterns('src/**/*.{ts,tsx}, docs/**,  ,e2e/*')).toEqual([
      'src/**/*.{ts,tsx}',
      'docs/**',
      'e2e/*',
    ]);
  });
});

describe('writeQwenRule', () => {
  it('новое правило без полей — только тело, без пустого блока frontmatter', () => {
    expect(writeQwenRule('', {}, 'Правило\n')).toBe('Правило\n');
  });

  it('шаблоны пишутся списком paths, alwaysApply не появляется', () => {
    const next = writeQwenRule(
      '',
      { description: 'Тесты', globs: 'e2e/**, src/*.{ts,tsx}' },
      'b\n',
    );
    expect(next).toBe('---\ndescription: Тесты\npaths:\n  - e2e/**\n  - src/*.{ts,tsx}\n---\nb\n');
    expect(next).not.toContain('alwaysApply');
  });

  it('снятые поля убирают весь frontmatter — Qwen не разбирает пустой блок', () => {
    expect(writeQwenRule('---\npaths:\n  - a/**\n---\nb\n', {}, 'b\n')).toBe('b\n');
  });

  it('неизменённые шаблоны не трогают узел; комментарии и чужие ключи на месте', () => {
    const original = '---\n# свой комментарий\npaths: a/**\nowner: team\n---\nстарое\n';
    const next = writeQwenRule(original, { globs: 'a/**', description: 'D' }, 'новое\n');
    expect(next).toContain('# свой комментарий');
    expect(next).toContain('paths: a/**');
    expect(next).toContain('owner: team');
    expect(readQwenRule(next)).toEqual({
      fields: { globs: 'a/**', description: 'D' },
      body: 'новое\n',
      otherKeys: ['owner'],
    });
  });

  it('файл без frontmatter получает его, только когда поле задано', () => {
    const next = writeQwenRule('Тело\n', { globs: 'src/**' }, 'Тело\n');
    expect(next).toBe('---\npaths:\n  - src/**\n---\nТело\n');
  });
});
