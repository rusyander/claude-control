import type { PermissionDecision, PermissionItem } from '@agentdeck/contracts/portable-env';
import { serverText } from '../../../lib/server-texts.ts';
import { isModeRule, parsePermissionRule } from '../permissions-map.ts';
import type { GatewayToolCall, ToolGate } from './tool-gate.ts';

/**
 * БРОКЕР ПРАВ ДЛЯ ЧУЖОГО CLI (П4.2).
 *
 * Правило, которое цель не умеет выразить, до сих пор доезжало только текстом:
 * матрица верности честно роняла такую запись до `wired` с запасным `text`
 * (`fidelity.ts permissionVerdict` → `degraded`), и запас этот означал «модель
 * попросили, но никто не проверит». Здесь появляется тот, кто проверит.
 *
 * Механизм НЕ свой: брокер отдаёт те же ворота (`ToolGate`), что и события
 * инструментов, и висит на том же шве в `gateway/frames.ts`. Второй путь
 * принуждения разошёлся бы с первым в порядке кадров — а порядок там и есть
 * предмет (придержанный вызов, отказ вместо него, закрытие после решения).
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, из которых состоит модуль:
 *
 *  1. **Правило, которого нет, ничего не решает.** Вызов, не описанный ни одним
 *     правилом канона, брокер пропускает. Это не дыра, а граница: брокер
 *     принуждает ТО, ЧТО СКАЗАНО в каноне, и выдавать молчание канона за запрет
 *     значило бы запретить чужому CLI всё, чего человек не перечислил.
 *  2. **Порядок решений — `deny` → `ask` → `allow`**, а не порядок строк. Так
 *     считает Claude, и брокер обязан совпадать с ним, иначе перенос прав меняет
 *     их смысл. Совпадение проверяется не рассуждением, а таблицей сверки:
 *     `tools/qa/check-permission-broker.mjs` гоняет НАСТОЯЩИЙ `claude` с тем же
 *     набором правил и сверяет решение построчно.
 *  3. **Сравнить нечем — значит отказать** (fail-closed). Правило с уточнением
 *     аргумента, у которого в вызове не нашлось поля для сравнения, не
 *     «промахнулось»: запрет, молча ставший разрешением, — это худшее, что умеет
 *     сделать слой прав. Отказ называет причину вслух.
 *  4. **`ask` на проводе — это ЗАПРОС, а не запрет.** Спрашивают человека у
 *     панели; интерфейс чужого CLI нам не принадлежит, и рисовать диалог внутри
 *     него мы не беремся (сказано в объёме тикета). Запрос без ответа
 *     оборачивается отказом по таймауту — висеть вечно он не может: на другом
 *     конце ждёт придержанный вызов и незакрытый ответ.
 */

/** Сколько ждать ответа человека на запрос прав, если срок не задан. */
export const DEFAULT_ASK_TIMEOUT_MS = 30_000;

/** Правило канона, которое решило судьбу вызова. */
export interface PermissionMatch {
  readonly decision: PermissionDecision;
  /** Строка правила, как она записана в каноне, — её читает и человек, и модель. */
  readonly rule: string;
}

/** Запрос прав к человеку: один вызов, одно правило, один ответ. */
export interface PermissionAskRequest {
  readonly call: GatewayToolCall;
  readonly rule: string;
}

/** Чем брокер отвечает и почему — для следа прогона. */
export type PermissionOutcome =
  /** Правила молчат: брокер не вмешивается. */
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'allowed'; readonly rule: string }
  | { readonly kind: 'denied'; readonly rule: string }
  /** Уточнение аргумента сравнить не с чем — отказано fail-closed. */
  | { readonly kind: 'unmatchable'; readonly rule: string }
  | { readonly kind: 'asked'; readonly rule: string; readonly answer: 'allow' | 'deny' }
  | { readonly kind: 'ask_timeout'; readonly rule: string }
  /** Правило говорит «спросить», а спрашивать некому: брокер без панели. */
  | { readonly kind: 'ask_nobody'; readonly rule: string };

export interface PermissionBrokerTarget {
  /** Права канона в том виде, в каком их несёт прогон. */
  readonly rules: readonly PermissionItem[];
  /**
   * Кто спрашивает человека. Нет его — `ask` становится отказом с названной
   * причиной, а не тихим разрешением.
   */
  readonly ask?: (request: PermissionAskRequest) => Promise<'allow' | 'deny'>;
  readonly askTimeoutMs?: number;
}

/**
 * Поле вызова, по которому сравнивается уточнение правила.
 *
 * Таблица короткая и закрытая НАМЕРЕННО: имя поля у инструмента — факт его
 * схемы, а не наша догадка, и придуманное соответствие превратило бы запрет в
 * разрешение молча. Инструмента здесь нет — сравнивать нечем, и решение уходит в
 * fail-closed (решение 3), а не в «правило не подошло».
 */
const ARGUMENT_FIELD: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
};

/** Значение, с которым сравнивается уточнение правила; `undefined` — сравнивать нечем. */
function argumentValueOf(call: GatewayToolCall): string | undefined {
  const fields = ARGUMENT_FIELD[call.name];
  if (!fields) return undefined;
  for (const field of fields) {
    const value = call.arguments?.[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Подходит ли уточнение правила значению вызова.
 *
 * Поддержаны ровно две формы, обе — из грамматики Claude: `префикс:*` (значение
 * начинается с префикса) и точное совпадение. Отдельно `*` — любое значение.
 * Всё остальное (гитигнор-шаблоны путей) здесь НЕ разбирается и честно отвечает
 * `undefined` — «не знаю», а не «не подошло»: разница между этими двумя ответами
 * и есть разница между отказом и молча снятым запретом.
 */
function argumentMatches(pattern: string, value: string): boolean | undefined {
  const spec = pattern.trim();
  if (spec === '' || spec === '*') return true;
  if (spec.endsWith(':*')) return value.startsWith(spec.slice(0, -2));
  if (spec.includes('*')) return undefined;
  return value === spec;
}

/** Решение по одному правилу применительно к одному вызову. */
type RuleFit = 'miss' | 'hit' | 'unmatchable';

function fitOf(item: PermissionItem, call: GatewayToolCall): RuleFit {
  // Выключенное право В СРЕДЕ человека есть, но НЕ ДЕЙСТВУЕТ: канон несёт его
  // ради честного паспорта (поле `enabled` заведено ровно для этого), а брокер
  // судит вызов только действующими. Иначе снятый человеком запрет продолжал бы
  // запрещать — и объяснить отказ правилом, которого в настройках нет, нечем.
  if (!item.enabled) return 'miss';

  // Режим подтверждений — настройка ВСЕГО ассистента, а не запись о вызове:
  // брокеру о конкретном вызове она не говорит ничего (см. `permissions-map.ts`).
  if (isModeRule(item.rule)) return 'miss';

  const parsed = parsePermissionRule(item.rule);
  if (parsed.kind !== 'rule') return 'miss';
  if (parsed.tool !== call.name) return 'miss';
  if (parsed.argument === null) return 'hit';

  const value = argumentValueOf(call);
  if (value === undefined) return 'unmatchable';
  const matched = argumentMatches(parsed.argument, value);
  if (matched === undefined) return 'unmatchable';
  return matched ? 'hit' : 'miss';
}

/**
 * Правило, решающее судьбу вызова.
 *
 * Порядок решений, а не порядок строк (решение 2): сперва любой `deny`, затем
 * любой `ask`, и только потом `allow`. Правило, чьё уточнение сравнить не с чем,
 * попадает в тот же перебор своим решением — иначе запрет, который не удалось
 * проверить, уступил бы разрешению, которое проверилось.
 */
export function matchPermission(
  rules: readonly PermissionItem[],
  call: GatewayToolCall,
): { readonly item: PermissionItem; readonly fit: RuleFit } | undefined {
  const fits = rules
    .map((item) => ({ item, fit: fitOf(item, call) }))
    .filter((candidate) => candidate.fit !== 'miss');
  const order: readonly PermissionDecision[] = ['deny', 'ask', 'allow'];
  for (const decision of order) {
    const found = fits.find((candidate) => candidate.item.decision === decision);
    if (found) return found;
  }
  return undefined;
}

/**
 * Отказ словами, которые прочитают и человек, и модель.
 *
 * Текст берётся кодом сообщения, а не строкой в домене: причина уезжает В ОТВЕТ
 * модели и В ПАНЕЛЬ человеку, а у них разные языки. Вторая копия этих слов на
 * английском разошлась бы с первой на первой же правке.
 */
function refusalText(outcome: PermissionOutcome): string {
  switch (outcome.kind) {
    case 'denied':
      return serverText('wire-permission-denied', { rule: outcome.rule });
    case 'unmatchable':
      return serverText('wire-permission-unmatchable', { rule: outcome.rule });
    case 'asked':
      return serverText('wire-permission-ask-denied', { rule: outcome.rule });
    case 'ask_timeout':
      return serverText('wire-permission-ask-timeout', { rule: outcome.rule });
    case 'ask_nobody':
      return serverText('wire-permission-ask-nobody', { rule: outcome.rule });
    default:
      return '';
  }
}

/**
 * Ответ человека или отказ по сроку.
 *
 * Гонка, а не `AbortSignal` у спрашивающего: отменить вопрос, уже показанный
 * человеку, панель не умеет, и притворяться, что умеет, значило бы обещать
 * несуществующее. Проигравший ответ просто никому не нужен — придержанный вызов
 * к этому времени уже отпущен отказом.
 */
async function askWithin(
  target: PermissionBrokerTarget,
  request: PermissionAskRequest,
): Promise<'allow' | 'deny' | 'timeout'> {
  const timeoutMs = target.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    // Спрашивающий, упавший с ошибкой, — это НЕ разрешение: у блокирующего
    // решения отказ по умолчанию, как и у хука (fail-closed).
    const answer = target.ask?.(request).catch(() => 'deny' as const);
    return await Promise.race([answer ?? Promise.resolve('deny' as const), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ворота из набора прав. Возвращается тот же `ToolGate`, что и у событий
 * инструментов, — чтобы шов в шлюзе остался один.
 */
export function permissionBrokerOf(
  target: PermissionBrokerTarget,
  /** Полный исход — для следа прогона; отказ и так виден в ответе. */
  onOutcome?: (outcome: PermissionOutcome, call: GatewayToolCall) => void,
): ToolGate {
  return {
    async decide(call) {
      const outcome = await decideOutcome(target, call);
      onOutcome?.(outcome, call);
      const allow =
        outcome.kind === 'unmatched' ||
        outcome.kind === 'allowed' ||
        (outcome.kind === 'asked' && outcome.answer === 'allow');
      if (allow) return { allow: true };
      return { allow: false, reason: refusalText(outcome) };
    },
  };
}

async function decideOutcome(
  target: PermissionBrokerTarget,
  call: GatewayToolCall,
): Promise<PermissionOutcome> {
  const found = matchPermission(target.rules, call);
  if (!found) return { kind: 'unmatched' };

  const rule = found.item.rule;
  if (found.fit === 'unmatchable') return { kind: 'unmatchable', rule };

  switch (found.item.decision) {
    case 'allow':
      return { kind: 'allowed', rule };
    case 'deny':
      return { kind: 'denied', rule };
    default:
      break;
  }

  if (!target.ask) return { kind: 'ask_nobody', rule };
  const answer = await askWithin(target, { call, rule });
  if (answer === 'timeout') return { kind: 'ask_timeout', rule };
  return { kind: 'asked', rule, answer };
}
