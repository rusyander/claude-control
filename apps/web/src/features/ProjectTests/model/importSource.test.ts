import { describe, expect, it } from 'vitest';
import { importSource } from './importSource';

describe('importSource', () => {
  it('выбранный файл уходит содержимым, путь из поля не подмешивается', () => {
    expect(importSource('Название\nx\n', 'QA/cases.csv')).toEqual({ content: 'Название\nx\n' });
  });

  it('пустой выбранный файл — отказ, а не импорт файла по пути из поля', () => {
    expect(importSource('', 'QA/cases.csv')).toBe('empty');
    expect(importSource('  \n', '')).toBe('empty');
  });

  it('без выбранного файла — путь из поля, пустое поле — ничего', () => {
    expect(importSource(undefined, '  QA/cases.csv ')).toEqual({ file: 'QA/cases.csv' });
    expect(importSource(undefined, '   ')).toEqual({ file: undefined });
  });
});
