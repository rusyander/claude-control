import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GroupSignal } from '@agentdeck/contracts/group-watch';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { HubSummary } from './HubSummary';

/**
 * Сводка хаба (L37) и её ранний выход: пустых корзин, времени и активных
 * сигналов нет — строки нет вовсе. Один активный сигнал сторожа — уже повод
 * для строки, даже когда корзины пусты (F-74).
 */
const NOW = Date.parse('2026-10-22T10:00:00.000Z');

const signal = (over: Partial<GroupSignal> = {}): GroupSignal => ({
  id: 's1',
  rule: 'R4',
  severity: 'warn',
  groupIndex: 0,
  chatId: 'c0',
  at: '2026-10-22T09:55:00.000Z',
  numbers: { runs: 3 },
  textKey: 'groupWatch.rule.R4',
  ...over,
});

// Строка, которая не попадает ни в одну корзину сводки: отброшенный чат.
const row = (over: Partial<ChildStageGroup> = {}): ChildStageGroup => ({
  chatId: 'c0',
  title: 'Работа',
  stages: ['work'],
  isRunning: false,
  retired: true,
  ...over,
});

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('HubSummary — ранний выход', () => {
  it('ни корзин, ни времени, ни сигналов — строки нет', () => {
    expect(renderToStaticMarkup(<HubSummary groups={[]} now={NOW} />)).toBe('');
    expect(renderToStaticMarkup(<HubSummary groups={[row()]} now={NOW} />)).toBe('');
  });

  it('только закрытые сигналы — тоже нет: в сводку идут активные', () => {
    const cleared = row({ watchSignals: [signal({ clearedAt: '2026-10-22T09:58:00.000Z' })] });
    expect(renderToStaticMarkup(<HubSummary groups={[cleared]} now={NOW} />)).toBe('');
  });

  it('один активный сигнал — строка с одной фишкой сигналов', () => {
    const html = renderToStaticMarkup(
      <HubSummary groups={[row({ watchSignals: [signal()] })]} now={NOW} />,
    );
    expect(html).toContain('data-hub-summary');
    expect(html).toContain('data-hub-count="signals"');
    expect(html).toContain('сигнал: 1');
    expect(html).not.toContain('data-hub-elapsed');
  });
});

/** Группа с подведённым (или нет) ожиданием подогрева кэша. */
const warmed = (keepWarm: { saved?: number; settled?: number; realized?: number }) =>
  row({
    retired: false,
    status: 'done',
    tokens: {
      flags: [],
      ledger: {
        at: '2026-10-22T09:00:00.000Z',
        keepWarm: {
          pings: 2,
          hits: 2,
          misses: 0,
          input: 4,
          cacheRead: 200_000,
          cacheWrite: 300,
          output: 2,
          lastAt: '2026-10-22T09:00:00.000Z',
          ...keepWarm,
        },
      },
    },
  });

/** Фишка итога: тон и текст без тегов (неразрывный пробел Intl — обычным). */
function warmChip(html: string): { tone?: string; text?: string } {
  const match = /data-hub-keep-warm-total="(\w+)"[^>]*>([^<]*)</.exec(html);
  return match ? { tone: match[1], text: match[2]?.replace(/\u00a0/g, ' ') } : {};
}

describe('HubSummary — итог подогрева кэша по разделению', () => {
  it('сумма подведённых ожиданий в плюс — зелёная «сберегли»; неподведённое не входит', () => {
    const html = renderToStaticMarkup(
      <HubSummary
        groups={[
          warmed({ saved: 190_000, settled: 1, realized: 1 }),
          warmed({ saved: -12_000, settled: 1, realized: 0 }),
          // Исход неизвестен — прежний «saved» без итога не сбережение.
          warmed({ saved: 500_000 }),
        ]}
        now={NOW}
      />,
    );
    expect(warmChip(html)).toEqual({
      tone: 'saved',
      text: 'подогрев кэша: сберегли ≈ 178 тыс. токенов',
    });
    expect(html).toContain('групп: 2');
  });

  it('сумма в минус — жёлтая «переплатили», число без знака', () => {
    const html = renderToStaticMarkup(
      <HubSummary
        groups={[
          warmed({ saved: 30_000, settled: 1, realized: 1 }),
          warmed({ saved: -75_000, settled: 2, realized: 0 }),
        ]}
        now={NOW}
      />,
    );
    expect(warmChip(html)).toEqual({
      tone: 'lost',
      text: 'подогрев кэша: переплатили ≈ 45 тыс. токенов',
    });
  });

  it('ни одного подведённого ожидания — фишки нет', () => {
    const html = renderToStaticMarkup(
      <HubSummary groups={[warmed({ saved: 90_000 }), row({ retired: false })]} now={NOW} />,
    );
    expect(html).toContain('data-hub-summary');
    expect(html).not.toContain('data-hub-keep-warm-total');
  });

  it('ноль: «сберегли», только если продолжение прочло удержанный кэш', () => {
    const even = renderToStaticMarkup(
      <HubSummary groups={[warmed({ saved: 0, settled: 1, realized: 1 })]} now={NOW} />,
    );
    expect(warmChip(even).tone).toBe('saved');
    const wasted = renderToStaticMarkup(
      <HubSummary groups={[warmed({ saved: 0, settled: 1, realized: 0 })]} now={NOW} />,
    );
    expect(warmChip(wasted)).toEqual({
      tone: 'lost',
      text: 'подогрев кэша: переплатили ≈ 0 токенов',
    });
  });

  it('en: итог языком интерфейса', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(
      <HubSummary groups={[warmed({ saved: 190_000, settled: 1, realized: 1 })]} now={NOW} />,
    );
    await i18n.changeLanguage('ru');
    expect(warmChip(html)).toEqual({ tone: 'saved', text: 'cache warming: saved ≈ 190K tokens' });
  });
});
