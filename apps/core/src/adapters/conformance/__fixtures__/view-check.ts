import { expect } from 'vitest';
import type { SessionStreamEvent } from '@agentdeck/contracts/core/session-stream';
import type { AdapterEvent, CliAdapter } from '../../adapter.types.ts';
import { replaySession, viewOf } from '../../sdk-stream/stream-view.ts';

/**
 * Вид сеанса (этап 10, `GET …/sessions/:sid/stream`) над каталогом настоящего запуска: повтор
 * `stdout.log` через `streamNormaliser` переходника обязан дать то же, что живой насос отдал ядру
 * (`seen`), и ходы человека на своих местах. Сравнение — до последнего конца хода: хвост, который
 * насос ещё не дочитал, в сравнение не идёт.
 */

type ViewEvent = Pick<SessionStreamEvent, 'kind' | 'data'>;

const upToLastEnd = <T extends { kind: string }>(events: T[]): T[] =>
  events.slice(0, events.map((e) => e.kind).lastIndexOf('turn-end') + 1);

export function expectViewMatchesPump(
  adapter: CliAdapter,
  dir: string,
  seen: readonly AdapterEvent[],
  turns: { said: string; answer: string }[],
): void {
  expect(adapter.streamNormaliser, `${adapter.id} has no session view`).toBeTypeOf('function');
  const page = replaySession(dir, adapter.streamNormaliser!(dir), 0);
  const view = upToLastEnd(page.events);
  const live: ViewEvent[] = upToLastEnd(
    seen.flatMap((e) => {
      const v = viewOf(e);
      return v ? [v] : [];
    }),
  );
  // Тот же разбор: всё, кроме хода человека (его в выводе CLI нет), — события насоса один в один.
  expect(
    view.filter((e) => e.kind !== 'user-text').map(({ kind, data }) => ({ kind, data })),
  ).toEqual(live);
  const kinds = view.map((e) => e.kind);
  expect(kinds.filter((k) => k === 'turn-end')).toHaveLength(turns.length);
  // Каждый ход: слова человека, затем ответ модели и конец хода без ошибки.
  let at = 0;
  for (const turn of turns) {
    const said = view.findIndex((e, i) => i >= at && e.kind === 'user-text');
    expect(said, JSON.stringify(view)).toBeGreaterThanOrEqual(at);
    expect(String((view[said]?.data as { text?: unknown }).text)).toContain(turn.said);
    const end = view.findIndex((e, i) => i > said && e.kind === 'turn-end');
    const text = view
      .slice(said, end)
      .filter((e) => e.kind === 'assistant-text')
      .map((e) => String((e.data as { text?: unknown }).text))
      .join('');
    expect(text).toBe(turn.answer);
    expect(view[end]?.data).toMatchObject({ isError: false });
    at = end + 1;
  }
}
