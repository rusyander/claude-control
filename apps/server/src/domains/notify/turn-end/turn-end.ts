import { askOf, askOfTool, closedClaim, summaryOf, waitsInText } from './turn-text.ts';
import type { IntermediateReason, TurnEnd, TurnEndFacts } from './turn-end.types.ts';

export type { IntermediateReason, TurnEnd, TurnEndFacts } from './turn-end.types.ts';

/**
 * Что значит конец хода для человека в Telegram (решение владельца 30.10.2026).
 *
 * Карточек две: «Задача закрыта» — вся задача сделана и агент свободен; «Агент
 * ждёт вас» — нужно прийти и решить. Всё прочее — промежуточная остановка, и о
 * ней не пишут: выборка 28–30.10 — из тридцати «ГОТОВО» ждали человека четыре,
 * закрытых было одно-два, остальные — «жду агентов», «гейт ещё идёт», «дальше
 * делаю …», а часть ушла посреди хода.
 *
 * Сомнение — не писать. Исключение одно: явное ожидание (висящий вопрос
 * инструментом, разрешение, ответ, который просит выбрать). Оно сильнее
 * «закрыта»: «Задача закрыта. Опубликовать замечания в MR?» ждёт человека.
 *
 * Порядок проверок и есть правило:
 * 1. работа пошла дальше, ход оборван, чат — звено группы → промежуточный;
 * 2. висит вопрос инструментом → ждёт;
 * 3. ответ ждёт решения словами → ждёт;
 * 4. фон ещё идёт, назначено пробуждение → промежуточный;
 * 5. ответ говорит «задача закрыта» (не «зона», не «фаза», не «не закрыта») → закрыта;
 * 6. иначе → промежуточный.
 */
export function classifyTurnEnd(facts: TurnEndFacts): TurnEnd {
  const answer = facts.answer ?? '';
  if (facts.continued) return intermediate('continued');
  if (facts.interrupted) return intermediate('interrupted');
  if (facts.subtask) return intermediate('subtask');
  if (facts.asked) {
    const fromTool = facts.question?.trim() ? askOfTool(facts.question, facts.options) : undefined;
    const ask = fromTool ?? askOf(answer);
    return { kind: 'waiting', ask: ask.ask, options: ask.options };
  }
  if (waitsInText(answer)) return { kind: 'waiting', ...askOf(answer) };
  if (facts.background) return intermediate('background');
  if (facts.wakeup) return intermediate('wakeup');
  if (closedClaim(answer)) return { kind: 'closed', summary: summaryOf(answer) };
  return intermediate(answer.trim() ? 'progress' : 'empty');
}

const intermediate = (reason: IntermediateReason): TurnEnd => ({ kind: 'intermediate', reason });
