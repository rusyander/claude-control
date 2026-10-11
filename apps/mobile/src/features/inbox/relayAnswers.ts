import type { InboxAsk, OutsideAnswer } from '@agentdeck/contracts/chat-inbox';
import type { CardState } from './queue.types';

/** Одно решение для хука панели: на какой вызов и что ему отдать. */
export interface RelayDecision {
  toolUseId: string;
  body: OutsideAnswer;
  keys: string[];
}

/**
 * Решения карточки сессии вне панели — в форме, которую ждёт хук панели.
 * Запрос прав — «разрешить / запретить». Вопрос `AskUserQuestion` — текст
 * вопроса → выбранное, несколько вариантов через запятую (так же их сводит сам
 * Claude Code); один вызов — один ответ на все его вопросы. Пока хоть что-то не
 * решено или не всё держит хук панели — решений нет.
 */
export function relayDecisions(
  asks: readonly InboxAsk[],
  state: CardState,
): RelayDecision[] | undefined {
  if (!isRelayCard(asks)) return undefined;
  const out: RelayDecision[] = [];
  const calls = new Map<string, { answers: { [question: string]: string }; keys: string[] }>();
  for (const ask of asks) {
    const given = state.answers[ask.key];
    if (ask.kind === 'permission') {
      if (given?.kind !== 'permission') return undefined;
      out.push({ toolUseId: ask.toolUseId, body: { behavior: given.behavior }, keys: [ask.key] });
      continue;
    }
    if (ask.kind !== 'question' || !ask.toolUseId) return undefined;
    if (given?.kind !== 'question' || given.labels.length === 0) return undefined;
    const call = calls.get(ask.toolUseId) ?? { answers: {}, keys: [] };
    call.answers[ask.question.question] = given.labels.join(', ');
    call.keys.push(ask.key);
    calls.set(ask.toolUseId, call);
  }
  for (const [toolUseId, { answers, keys }] of calls) {
    out.push({ toolUseId, body: { answers }, keys });
  }
  return out;
}

/** Карточка решается через хук панели: всё в ней держит хук. */
export function isRelayCard(asks: readonly InboxAsk[]): boolean {
  return (
    asks.length > 0 &&
    asks.every(
      (ask) => (ask.kind === 'question' || ask.kind === 'permission') && ask.relay === true,
    )
  );
}
