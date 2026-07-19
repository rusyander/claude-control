import { describe, it, expect } from 'vitest';
import { safeSegment, layoutOf } from './registry.ts';

/**
 * Тесты идентификатора ресурса. safeSegment — первая линия защиты: он не
 * должен превращать чужой ввод в путь к корню каталога или наружу. Аудит
 * нашёл здесь дыру (кириллица схлопывалась в пустоту), поэтому граничные
 * случаи закреплены.
 */
describe('registry.safeSegment', () => {
  it('пропускает нормальное имя', () => {
    expect(safeSegment('frontend-architecture')).toBe('frontend-architecture');
  });

  it('оставляет допустимые символы имени плагина', () => {
    expect(safeSegment('code-review@claude-plugins')).toBe('code-review@claude-plugins');
  });

  it('кириллица без латиницы отвергается', () => {
    expect(safeSegment('скилл')).toBeUndefined();
  });

  it('эмодзи отвергается', () => {
    expect(safeSegment('🎉')).toBeUndefined();
  });

  it('пустая строка отвергается', () => {
    expect(safeSegment('')).toBeUndefined();
  });

  it('точки отвергаются целиком', () => {
    expect(safeSegment('.')).toBeUndefined();
    expect(safeSegment('..')).toBeUndefined();
    expect(safeSegment('...')).toBeUndefined();
  });

  it('вырезает опасные символы, оставляя безопасную часть', () => {
    expect(safeSegment('a/../b')).toBe('a..b');
  });
});

describe('registry.layoutOf', () => {
  it('знает свои виды', () => {
    expect(layoutOf('skill')?.isDirectory).toBe(true);
    expect(layoutOf('script')?.isDirectory).toBe(false);
  });

  it('плагин — только чтение', () => {
    expect(layoutOf('plugin')?.isWritable).toBe(false);
  });

  it('скилл и скрипт — с записью', () => {
    expect(layoutOf('skill')?.isWritable).toBe(true);
    expect(layoutOf('script')?.isWritable).toBe(true);
  });

  it('неизвестный вид — undefined', () => {
    expect(layoutOf('nonsense')).toBeUndefined();
  });
});
