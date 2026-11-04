import type { AdapterEvent, TurnUsage } from '../adapter.types.ts';

/**
 * CLI, говорящий JSON-RPC по stdio (`codex app-server`, ACP `opencode acp`): насос сеанса
 * (`rpc-session.ts`) один, диалект — у переходника. Диалект без IO: строка вывода CLI → события
 * ядра и строки, которые надо записать в stdin (продолжение рукопожатия, ответы на запросы CLI).
 */

/** Строка в stdin CLI: `key` — ключ хоста (повтор того же ключа хост не пишет). */
export interface RpcOut {
  key: string;
  line: string;
}

export interface RpcStep {
  events: AdapterEvent[];
  out: RpcOut[];
}

export interface RpcDialect {
  /** Первые строки после запуска (начало рукопожатия). */
  start(): RpcOut[];
  /** Одна строка stdout CLI. */
  push(line: string): RpcStep;
  /** Ход можно отправить сейчас: рукопожатие кончилось и прежний ход завершён. */
  readonly ready: boolean;
  /** Рукопожатие сорвалось: отправки отказываются с этой причиной. */
  readonly failed: string | null;
  /** Строка хода нашей отправки; диалект запоминает ожидание эха (`uuid`). */
  turn(text: string, cmdId: string, uuid: string): RpcOut;
  /** Хост не записал ход: ожидание его эха снимается. */
  forget(cmdId: string): void;
  /**
   * Ход не ушёл и не записан (запись ввода упала сразу после `turn()`): диалект возвращается в
   * состояние до `turn()`, id запроса тоже. Иначе повтор `stdout.log` (вид сеанса), не знающий об
   * этом ходе, раздаёт следующим запросам id на единицу меньше живых и теряет их ответы.
   * Ход, дошедший до записи ввода, снимается `forget` — повтор его тоже разыгрывает.
   */
  retract(cmdId: string): void;
  /** Ответ ядра на `permit.request` в форме CLI; `undefined` — запроса с таким id не было. */
  answer(requestId: string, reply: unknown): RpcOut | undefined;
  readonly conversationId: string | null;
  usage(): TurnUsage[];
}
