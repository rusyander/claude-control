import { describe, it, expect } from 'vitest';
import { formatBytes } from './format';
import { formatMoney, formatPercent, formatCompact } from './format-number';
import { sourceLabel } from './location-label';
import type { ClaudeLocation } from '@claude-control/contracts';

/**
 * Форматирование чисел и подписей. Логики тут немного, но она на виду:
 * размеры файлов, оценка расхода и подпись источника конфигурации попадают
 * в интерфейс как есть. Проверяем прежде всего границы — именно на них
 * форматтеры и ошибаются.
 */

describe('formatBytes', () => {
  it('до килобайта показывает байты', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('ровно килобайт переходит в KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('последнее значение перед мегабайтом остаётся в KB', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  it('ровно мегабайт переходит в MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('крупный размер округляется до десятых', () => {
    expect(formatBytes(5.25 * 1024 * 1024)).toBe('5.3 MB');
  });
});

describe('formatMoney', () => {
  it('до сотни показывает центы', () => {
    // Граница ровно на 100: ниже — два знака, от ста — целые доллары.
    expect(formatMoney(12.34, 'en-US')).toBe('$12.34');
    expect(formatMoney(99.99, 'en-US')).toBe('$99.99');
  });

  it('от сотни округляет до целых', () => {
    expect(formatMoney(100, 'en-US')).toBe('$100');
    expect(formatMoney(1234.56, 'en-US')).toBe('$1,235');
  });

  it('ноль показывается с центами', () => {
    expect(formatMoney(0, 'en-US')).toBe('$0.00');
  });
});

describe('formatPercent и formatCompact', () => {
  it('доля переводится в проценты', () => {
    expect(formatPercent(0.5, 'en-US')).toBe('50%');
    expect(formatPercent(0.123, 'en-US')).toBe('12.3%');
  });

  it('большое число записывается компактно', () => {
    expect(formatCompact(21_152_612_996, 'en-US')).toBe('21.2B');
  });

  it('маленькое число компактная запись не портит', () => {
    expect(formatCompact(42, 'en-US')).toBe('42');
  });
});

describe('sourceLabel', () => {
  /** Подставляем сам ключ — так видно, какую подпись выбрала функция. */
  const t = (key: string): string => key;

  const location = (extra: Partial<ClaudeLocation>): ClaudeLocation =>
    ({ isValid: true, source: 'home', ...extra }) as ClaudeLocation;

  it('невалидный путь важнее источника', () => {
    // Иначе пользователь увидит «определён автоматически» у несуществующей папки.
    expect(sourceLabel(location({ isValid: false, source: 'manual' }), t)).toBe(
      'overview.notFound',
    );
  });

  it('путь, заданный руками', () => {
    expect(sourceLabel(location({ source: 'manual' }), t)).toBe('overview.detectedManual');
  });

  it('путь из переменной окружения', () => {
    expect(sourceLabel(location({ source: 'env' }), t)).toBe('overview.detectedEnv');
  });

  it('путь по умолчанию', () => {
    expect(sourceLabel(location({ source: 'home' }), t)).toBe('overview.detectedAuto');
  });
});
