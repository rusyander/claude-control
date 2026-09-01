import {
  contextHandoffProposal,
  type HandoffProposal,
} from '@claude-control/contracts/chat-handoff';

/**
 * Второй повод продолжить работу в чистой сессии — размер окна, а не смысл.
 *
 * Инициатива агента (`HANDOFF_SYSTEM_PROMPT`) отвечает на вопрос «задача
 * закрыта?». Этот модуль отвечает на другой: «разговор ещё имеет смысл
 * продолжать?». Разница практическая — окно растёт и у незакрытой работы, и
 * длинный разговор доезжает до автосжатия в самом CLI, где сводка превращается
 * в сводку сводок. Замеры по транскриптам за неделю: сессии упираются в 267–268k
 * и сжимаются, а ротация на 200k снимает около 60% перевыставляемого входа.
 *
 * Решает МОДУЛЬ, а делает планировщик: здесь только арифметика и никаких
 * побочных действий, поэтому поведение проверяется тестом без запуска CLI.
 *
 * Предохранители у обоих поводов ОБЩИЕ (`evaluateHandoff`): свежесть файла-опоры,
 * успешное завершение прогона, потолок цепочки. Порог ничего не смягчает — он
 * только даёт предложение там, где его иначе не было бы вовсе.
 */

export interface ContextRotationInput {
  /** Окно на последнем шаге прогона; 0 — расход не приходил. */
  contextTokens: number;
  /** Порог из настроек; 0 — не следить. */
  limit: number;
  /** Агент уже предложил продолжение сам — тогда повод не нужен. */
  hasProposal: boolean;
  /** Прогон завершился успешно: после ошибки и лимита продолжать нечего. */
  ok: boolean;
  /** Каталог разговора: без него продолжать негде. */
  hasProject: boolean;
}

export type ContextRotation =
  /** Порог не пройден, повода нет. */
  | { kind: 'none' }
  /** Порог пройден: панель подставляет своё предложение вместо агентского. */
  | { kind: 'propose'; proposal: HandoffProposal; contextTokens: number };

/**
 * Нужно ли предложить продолжение по размеру окна.
 *
 * Порядок проверок — от самой дешёвой к самой редкой. Предложение агента бьёт
 * порог: оно знает, ЧТО закрыто, а порог знает только «сколько накопилось», и
 * подменять осмысленный текст своим было бы потерей.
 */
export function planContextRotation({
  contextTokens,
  limit,
  hasProposal,
  ok,
  hasProject,
}: ContextRotationInput): ContextRotation {
  if (hasProposal) return { kind: 'none' };
  if (limit <= 0) return { kind: 'none' };
  if (!ok || !hasProject) return { kind: 'none' };
  if (contextTokens < limit) return { kind: 'none' };
  return { kind: 'propose', proposal: contextHandoffProposal(contextTokens), contextTokens };
}
