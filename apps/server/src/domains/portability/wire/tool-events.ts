import type { ConfigProvider } from '../../../providers/types.ts';
import { providerHookEvents } from '../hook-events.ts';
import {
  runSupervisorEvent,
  type SupervisorHook,
  type SupervisorEventOutcome,
} from '../supervisor/run.ts';
import type { SupervisorRun } from '../supervisor/payload.ts';

/**
 * СОБЫТИЯ ИНСТРУМЕНТОВ НА ПРОВОДЕ (П4.1).
 *
 * `PreToolUse` и `PostToolUse` отличаются от остальных семи событий тем, ГДЕ их
 * видно. Остальные происходят вокруг прогона, и панель их знает потому, что сама
 * прогон и затевает. Вызов инструмента происходит ВНУТРИ ответа модели, и увидеть
 * его панель может только там, где ответ через неё проходит, — то есть когда
 * трафик чужого CLI идёт через контур панели.
 *
 * Отсюда третье состояние владельца, которого нет у событий прогона: контур
 * выключен — отыгрывать НЕЧЕМ. Это не «работает молча хуже», это `×` в отчёте
 * верности, и сказано оно должно быть до запуска, а не после.
 *
 * Запрет действует ТОЛЬКО на `PreToolUse`: отказ после исполнения ничего не
 * останавливает, он лишь врёт модели о том, чего не было. Поэтому `PostToolUse`
 * здесь наблюдательное, как и в каноне (`needs.ts`).
 */

/** Кто отыгрывает событие инструмента у этой цели в ЭТОМ прогоне. */
export type ToolEventOwner =
  /** Умеет сам CLI — панель молчит, иначе скрипт сработал бы дважды. */
  | 'native'
  /** Отыгрывает провод панели: трафик идёт через контур. */
  | 'wire'
  /** Отыгрывать нечем: своего механизма у CLI нет, контур выключен. */
  | 'none';

export interface ToolEventConditions {
  /** Идёт ли трафик ЭТОГО прогона через контур панели. */
  readonly throughContour: boolean;
}

/**
 * Владелец события инструмента.
 *
 * Родной механизм сильнее провода: у `qwen` и `kimi` `PreToolUse` свой, и
 * исполнить хук ещё и на проводе значило бы запустить скрипт человека дважды на
 * одно действие — а решение об отказе принять два раза нельзя, второе уже
 * бессмысленно.
 */
export function toolEventOwner(
  provider: ConfigProvider,
  event: 'PreToolUse' | 'PostToolUse',
  conditions: ToolEventConditions,
): ToolEventOwner {
  if (providerHookEvents(provider).some((candidate) => candidate.name === event)) return 'native';
  return conditions.throughContour ? 'wire' : 'none';
}

/** Вызов инструмента, как его увидел провод. */
export interface WireToolCall {
  /** Идентификатор вызова — он же связывает решение с вызовом. */
  readonly id: string;
  readonly name: string;
  /** Аргументы РАЗОБРАННЫМ объектом: у Claude это поле — объект. */
  readonly input: unknown;
}

/** Решение по одному вызову. */
export interface WireToolDecision {
  readonly allow: boolean;
  /** Причина отказа — её читает и модель, и человек. Есть только у отказа. */
  readonly reason?: string;
  /** Отыграно ли событие вообще: `none` — владельца нет, и хуки не звались. */
  readonly owner: ToolEventOwner;
  /** Исход надзирателя целиком — для следа запроса и отчёта. */
  readonly outcome?: SupervisorEventOutcome;
}

export interface RunToolEventParams {
  readonly provider: ConfigProvider;
  readonly run: SupervisorRun;
  readonly call: WireToolCall;
  readonly event: 'PreToolUse' | 'PostToolUse';
  /** `PostToolUse`: что инструмент ответил. */
  readonly response?: unknown;
  readonly hooks: readonly SupervisorHook[];
  readonly conditions: ToolEventConditions;
  readonly timeoutMs?: number;
}

/**
 * Отыграть событие инструмента и получить решение.
 *
 * Механизм не свой: событие исполняет тот же `runSupervisorEvent`, что и события
 * прогона, — со тем же словарём кодов выхода, тем же таймаутом и тем же правилом
 * fail-closed на блокирующем событии. Второй исполнитель хуков разошёлся бы с
 * первым в смысле кода 2, и разошёлся бы молча.
 *
 * Владельца НЕ спрашивают дважды: если он не провод, хуки не запускаются вовсе, и
 * решение — «пропустить». Пропустить, а не отказать: события, которого панель не
 * отыгрывает, не существует, и выдавать его отсутствие за запрет нельзя.
 */
export async function runToolEvent(params: RunToolEventParams): Promise<WireToolDecision> {
  const owner = toolEventOwner(params.provider, params.event, params.conditions);
  if (owner !== 'wire') return { allow: true, owner };

  const outcome = await runSupervisorEvent({
    provider: params.provider,
    run: params.run,
    input: {
      event: params.event,
      toolName: params.call.name,
      toolInput: params.call.input,
      ...(params.event === 'PostToolUse' && params.response !== undefined
        ? { toolResponse: params.response }
        : {}),
    },
    hooks: params.hooks,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  });

  return {
    allow: !outcome.blocked,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    owner,
    outcome,
  };
}
