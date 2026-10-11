import type { TextStyle } from 'react-native';

/**
 * Токены оформления. Отдельным файлом, а не «цвета по месту»: экранов много, и
 * первый же захардкоженный оттенок делает второй неизбежным.
 *
 * Тема одна — тёмная. Панель в браузере умеет обе, но телефон с агентом смотрят
 * в основном не за столом, и светлая версия здесь была бы работой ради полноты.
 */

export const colors = {
  bg: '#0d1117',
  surface: '#161b22',
  surfaceRaised: '#1c2129',
  border: '#2a313c',
  text: '#e6edf3',
  textDim: '#8b949e',
  textFaint: '#6e7681',
  accent: '#6e8bff',
  accentDim: '#2a3350',
  /** Подложка «опасной» кнопки: красный на тёмном читается, но не кричит. */
  dangerDim: '#3b1d20',
  /** Мягкие подложки статусов — бейджи и плашки поверх карточки. */
  warningDim: '#3a2e12',
  successDim: '#173323',
  success: '#3fb950',
  warning: '#d29922',
  danger: '#f85149',
  /** Точки статусов прогонов — те же смыслы, что в панели. */
  running: '#6e8bff',
  waiting: '#d29922',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export const font = {
  small: 12,
  body: 14,
  title: 16,
  large: 20,
  /** Главная цифра экрана: стоимость за период. */
  hero: 30,
  /** Моноширинный: код, пути, вывод инструментов. */
  mono: 'monospace',
} as const;

/**
 * Цифры одной ширины: время «2 ч» и счётчики в колонке не пляшут от строки к
 * строке. Не моноширинный шрифт — у него свои пробелы, «2  ч» выглядит сломанным.
 */
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] };
