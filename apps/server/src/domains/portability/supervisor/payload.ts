import type { ConfigProvider } from '../../../providers/types.ts';
import { providerHookEvents } from '../hook-events.ts';

/**
 * НАГРУЗКА СОБЫТИЯ В ФОРМЕ CLAUDE — контракт надзирателя рантайма (П3.1).
 *
 * Панель сама запускает чужой CLI, значит она и есть его оболочка, и события
 * вокруг запуска принадлежат ей. Уже написанные скрипты хуков ждут на stdin
 * объект Claude (`hook_event_name`, `session_id`, `cwd`, `transcript_path`, …) —
 * этот модуль его и собирает, ничего не изобретая.
 *
 * Здесь НЕТ ни запуска скрипта, ни решения по коду выхода (это П3.2), ни событий
 * инструментов (`PreToolUse`/`PostToolUse` — П4). Модуль чистый: всё, что уходит
 * в нагрузку, приезжает описанием прогона. Ровно поэтому усыновлённый прогон
 * доигрывает события конца после перезапуска панели — описание переживает
 * сериализацию, а собирать нагрузку заново не из чего, кроме него.
 */

/**
 * События, которые надзиратель отыгрывает сам. Имена — Claude: скрипт, снятый с
 * Claude, обязан работать у чужого CLI без правки.
 *
 * `PreCompact` в этом списке потому, что у панели есть свой чек-пойнт передачи
 * (`provider-chat/handoff.ts`) — отыгрывать событие есть на чём.
 */
export const SUPERVISOR_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'Notification',
  'SessionEnd',
  'PreCompact',
] as const;

export type SupervisorEvent = (typeof SUPERVISOR_EVENTS)[number];

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
export type SessionEndReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other';
export type PreCompactTrigger = 'manual' | 'auto';

/**
 * Описание прогона — единственный источник общих полей нагрузки.
 *
 * Сериализуемо целиком и намеренно: усыновлённый прогон (панель перезапустилась,
 * пока чужой CLI работал) восстанавливает описание из состояния и собирает те же
 * события конца, что собрал бы без перезапуска. Держать здесь дескриптор
 * процесса или замыкание значило бы «события теряются молча».
 */
export interface SupervisorRun {
  /** Идентификатор провайдера в каталоге (`codex`, `gemini`, `qwen`, …). */
  readonly providerId: string;
  /**
   * Идентификатор разговора панели. Он же `session_id` нагрузки: скрипту нужен
   * ключ, по которому две реплики одного разговора склеиваются, и у чужого CLI
   * другого такого ключа нет.
   */
  readonly sessionId: string;
  /** Рабочий каталог прогона — тот же, что уедет чужому CLI. */
  readonly cwd: string;
  /**
   * Транскрипт, который скрипт вправе открыть и прочитать.
   *
   * У чужого CLI это СВОЙ файл панели
   * (`<appData>/provider-chats/<провайдер>/<id>.jsonl`), а не выдуманный путь к
   * истории, которой у цели нет: скрипт, читающий транскрипт, должен получить
   * существующий файл, иначе он падает на чужом CLI и молчит на Claude.
   * Собирает путь вызывающий (`provider-chat/store.ts` владеет раскладкой) —
   * модуль пути не строит, чтобы второй копии раскладки не появилось.
   */
  readonly transcriptPath: string;
}

/** Данные, которые приносит само событие. */
export interface SupervisorEventInput {
  readonly event: SupervisorEvent;
  /** `SessionStart`: чем начат разговор. */
  readonly source?: SessionStartSource;
  /**
   * `UserPromptSubmit`: текст человека.
   *
   * Пустая строка здесь — ЭТО ДАННЫЕ (человек отправил пустой запрос), а
   * `undefined` — их отсутствие. Разницу обязан видеть скрипт, поэтому первая
   * едет в нагрузку, вторая из неё исчезает.
   */
  readonly prompt?: string;
  /** `Notification`: текст уведомления. */
  readonly message?: string;
  /** `SessionEnd`: чем закончился разговор. */
  readonly reason?: SessionEndReason;
  /** `PreCompact`: кто позвал передачу. */
  readonly trigger?: PreCompactTrigger;
  /** `PreCompact`: указания человека к передаче, если он их дал. */
  readonly customInstructions?: string;
  /** `Stop` / `SubagentStop`: прогон уже продолжен решением хука. */
  readonly stopHookActive?: boolean;
}

/**
 * Какие поля СВЕРХ общих четырёх принадлежат событию — и в каком виде они
 * называются в нагрузке Claude.
 *
 * Таблица объявлена, а не выведена из набора переданных значений, по двум
 * причинам. Первая: набор заполненных полей каждого события зафиксирован тестом,
 * и фиксировать нужно объявление, а не случай вызова. Вторая: вызывающий,
 * передавший `prompt` в `SessionStart`, не должен протолкнуть его в нагрузку —
 * скрипт увидел бы поле, которого у события не бывает, и повёл себя не так, как
 * повёл бы у Claude.
 */
const EVENT_FIELDS = {
  SessionStart: { source: 'source' },
  UserPromptSubmit: { prompt: 'prompt' },
  Stop: { stopHookActive: 'stop_hook_active' },
  SubagentStop: { stopHookActive: 'stop_hook_active' },
  Notification: { message: 'message' },
  SessionEnd: { reason: 'reason' },
  PreCompact: { trigger: 'trigger', customInstructions: 'custom_instructions' },
} as const satisfies Record<SupervisorEvent, Readonly<Record<string, string>>>;

/** Общие поля — есть у каждого события, всегда заполнены описанием прогона. */
export const SUPERVISOR_COMMON_FIELDS = [
  'hook_event_name',
  'session_id',
  'cwd',
  'transcript_path',
] as const;

/** Имена полей нагрузки, которые может заполнить это событие. */
export function payloadFieldsOfEvent(event: SupervisorEvent): readonly string[] {
  return [...SUPERVISOR_COMMON_FIELDS, ...Object.values(EVENT_FIELDS[event])];
}

/**
 * Сборка нагрузки события.
 *
 * Поле, которое заполнить нечем, ОТСУТСТВУЕТ — пустая строка вместо него сделала
 * бы «данных нет» неотличимым от «данные пустые», и скрипт, который на это
 * смотрит, принял бы одно за другое.
 */
export function buildSupervisorPayload(
  run: SupervisorRun,
  input: SupervisorEventInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hook_event_name: input.event,
    session_id: run.sessionId,
    cwd: run.cwd,
    transcript_path: run.transcriptPath,
  };

  const fields: Readonly<Record<string, string>> = EVENT_FIELDS[input.event];
  for (const [inputKey, payloadKey] of Object.entries(fields)) {
    const value = (input as unknown as Record<string, unknown>)[inputKey];
    if (value !== undefined) payload[payloadKey] = value;
  }

  return payload;
}

/**
 * Нагрузка в том виде, в каком она уходит скрипту.
 *
 * Отдельная функция, а не `JSON.stringify` на месте вызова, — чтобы у сериализации
 * было одно место и один запрет: нагрузка уходит ТОЛЬКО через stdin. Через argv
 * она уезжать не имеет права: на Windows цепочка `cmd.exe` → `.cmd` → `.exe`
 * уничтожает текст с кавычками, и это уже оплачено однажды на
 * `--append-system-prompt`. JSON нагрузки состоит из кавычек целиком.
 */
export function encodeSupervisorPayload(run: SupervisorRun, input: SupervisorEventInput): string {
  return JSON.stringify(buildSupervisorPayload(run, input));
}

/** Кто отыгрывает событие у этой цели. */
export type HookEventOwner = 'native' | 'supervisor';

/**
 * У события ровно один владелец.
 *
 * Есть событие у самого CLI (`qwen`, `kimi` — свой механизм хуков; Claude — своя
 * модель) → отыгрывает ОН, надзиратель молчит. Нет → отыгрывает надзиратель.
 * Иначе скрипт срабатывал бы дважды на одно действие, а перенесённый хук считал
 * бы каждое событие за два.
 *
 * `writeDisabledReason` на владельца не влияет: он запрещает ПАНЕЛИ писать в
 * раздел, а не отменяет события, которые у CLI есть.
 */
export function hookEventOwner(provider: ConfigProvider, event: SupervisorEvent): HookEventOwner {
  const native = providerHookEvents(provider).some((candidate) => candidate.name === event);
  return native ? 'native' : 'supervisor';
}

/** События, которые у этой цели отыгрывает надзиратель, — строка отчёта верности. */
export function supervisorOwnedEvents(provider: ConfigProvider): readonly SupervisorEvent[] {
  return SUPERVISOR_EVENTS.filter((event) => hookEventOwner(provider, event) === 'supervisor');
}
