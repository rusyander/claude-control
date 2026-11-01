/**
 * Ходы одной сессии для золотого P43: по ним однажды посчитана аналитика панели
 * (`scanAnalytics` над транскриптом из этих же ходов, 30.10.2026), её числа — в `PANEL_GOLDEN`.
 * Ход `m5` записан дважды: CLI повторяет ответ с растущим выходом, считается полный.
 */
export interface GoldenTurn {
  messageId: string;
  model: string;
  /** ISO — момент хода; цена берётся на него (вводная цена Sonnet 5 до 31.08.2026). */
  at: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

export const P43_TURNS: readonly GoldenTurn[] = [
  {
    messageId: 'm1',
    model: 'claude-opus-4-8',
    at: '2026-10-20T10:00:00.000Z',
    input: 1200,
    cacheRead: 50_000,
    cacheWrite: 8000,
    cacheWrite1h: 6000,
    output: 900,
  },
  {
    messageId: 'm2',
    model: 'claude-sonnet-5',
    at: '2026-08-20T09:00:00.000Z',
    input: 3000,
    cacheRead: 20_000,
    cacheWrite: 4000,
    cacheWrite1h: 0,
    output: 1500,
  },
  {
    messageId: 'm3',
    model: 'claude-sonnet-5',
    at: '2026-09-10T09:00:00.000Z',
    input: 3000,
    cacheRead: 20_000,
    cacheWrite: 4000,
    cacheWrite1h: 0,
    output: 1500,
  },
  {
    messageId: 'm4',
    model: 'claude-haiku-4-5',
    at: '2026-10-01T12:00:00.000Z',
    input: 500,
    cacheRead: 0,
    cacheWrite: 2000,
    cacheWrite1h: 2000,
    output: 300,
  },
  {
    messageId: 'm5',
    model: 'claude-opus-4-8',
    at: '2026-10-20T10:05:00.000Z',
    input: 40,
    cacheRead: 60_000,
    cacheWrite: 1000,
    cacheWrite1h: 0,
    output: 100,
  },
  {
    messageId: 'm5',
    model: 'claude-opus-4-8',
    at: '2026-10-20T10:05:02.000Z',
    input: 40,
    cacheRead: 60_000,
    cacheWrite: 1000,
    cacheWrite1h: 0,
    output: 400,
  },
];
