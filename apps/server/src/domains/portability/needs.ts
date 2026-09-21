import { readFileSync, statSync } from 'node:fs';
import type {
  EnvBlocking,
  EnvNeed,
  EnvNeeds,
  EnvTrigger,
  SessionEvent,
  ToolEvent,
} from '@agentdeck/contracts/portable-env';
import { needsFacts, needsNone, needsUndetermined } from './canon.ts';

/**
 * Что записи НУЖНО от рантайма — сердце всей партии: по `needs` матрица
 * ВЫЧИСЛЯЕТ уровень верности, а не берёт его из таблицы, написанной рукой.
 *
 * Требования хука выводятся ДВУМЯ способами, и слабейший не признаётся
 * достаточным (П0.2):
 *
 *  1. `declared` — событие само задаёт нагрузку однозначно: `PreToolUse` без
 *     имени и аргументов инструмента не бывает. Это ФАКТ формата.
 *  2. `static` — разбор текста скрипта: какие поля нагрузки он читает. Это
 *     ГИПОТЕЗА. Она показывается человеку и им же правится, и одна она поводом
 *     назвать запись переносимой не является.
 *  3. `observed` — живой прогон (`needs-probe.ts`): скрипту подсунули нагрузку
 *     через объект-перехватчик и записали, какие поля он на самом деле прочитал.
 *
 * Невыводимое (динамический доступ `payload[key]`, вызов другого скрипта, чтение
 * транскрипта) НЕ становится пустым массивом: это `undetermined`, ХУДШИЙ уровень
 * и решение человека. Молчаливое «ничего не нужно» — та же ложь, что молчаливая
 * потеря.
 */

/** События инструмента у claude-совместимых CLI (claude, qwen, kimi). */
const TOOL_EVENT_NEEDS: Record<string, readonly EnvNeed[]> = {
  PreToolUse: ['tool_name', 'tool_input'],
  PostToolUse: ['tool_name', 'tool_input', 'tool_result'],
  PostToolUseFailure: ['tool_name', 'tool_input', 'tool_result'],
  PermissionRequest: ['tool_name', 'tool_input'],
  PermissionDenied: ['tool_name', 'tool_input'],
  PermissionResult: ['tool_name', 'tool_input', 'tool_result'],
};

/**
 * События сессии: минимальный факт, О КОТОРОМ событие. Транскрипт и рабочий
 * каталог в нагрузке есть почти всегда, но объявлять их нужными каждому хуку
 * нельзя — тогда непереносимым оказался бы вообще любой хук, и матрица потеряла
 * бы смысл. Что скрипт читает СВЕРХ этого, добавляет статический разбор.
 */
const SESSION_EVENT_NEEDS: Record<string, readonly EnvNeed[]> = {
  UserPromptSubmit: ['prompt'],
  SessionStart: ['session_id'],
  SessionEnd: ['session_id'],
  Stop: ['session_id'],
  StopFailure: ['session_id'],
  Interrupt: ['session_id'],
  SubagentStart: ['subagent'],
  SubagentStop: ['subagent'],
  PreCompact: ['compact'],
  PostCompact: ['compact'],
  Notification: ['session_id'],
  MessageDisplay: ['session_id'],
  TodoCreated: ['session_id'],
  TodoCompleted: ['session_id'],
};

/** Событие инструмента — по нему матрица разводит две строки хуков. */
export function isToolEventName(event: string): boolean {
  return event in TOOL_EVENT_NEEDS;
}

/**
 * Событие → триггер канона. Незнакомое имя события НЕ угадывается: оно едет
 * `session` с ближайшим смыслом только если известно, иначе вызывающий обязан
 * сказать, что событие чужое (fail-closed у него).
 */
export function triggerOfEvent(event: string, matcher: string | null): EnvTrigger | undefined {
  const toolEvent = TOOL_EVENT_OF_NAME[event];
  if (toolEvent) return { on: 'tool', event: toolEvent, match: matcher };
  const session = SESSION_EVENT_OF_NAME[event];
  if (session) return { on: 'session', event: session };
  if (event === 'UserPromptSubmit') return { on: 'prompt' };
  return undefined;
}

/**
 * Имя события источника → событие ИНСТРУМЕНТА канона. Таблица, а не приставка
 * `Pre`: по ней `PermissionRequest` и `PermissionDenied` оказывались
 * `post_tool`, то есть запирающий разрешение хук переносился наблюдателем ПОСЛЕ
 * вызова — снятый запрет, худшая сторона инварианта 6.
 */
const TOOL_EVENT_OF_NAME: Record<string, ToolEvent> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PostToolUseFailure: 'post_tool',
  // Решение о разрешении принимается ДО вызова: оба события запирают инструмент.
  PermissionRequest: 'pre_tool',
  PermissionDenied: 'pre_tool',
  // А это — итог уже состоявшегося вызова: нагрузка объявляет `tool_result`.
  PermissionResult: 'post_tool',
};

/**
 * Имя события источника → событие сессии канона. ТОЛЬКО точные соответствия.
 *
 * Здесь стояли ещё семь строк, и каждая была выдумкой: `SubagentStart` ехал как
 * `subagent_stop` (хук на ЗАПУСК субагента переносился на его завершение),
 * `PostCompact` — как `pre_compact`, `Interrupt` и `StopFailure` — как обычный
 * `stop`, `MessageDisplay`/`TodoCreated`/`TodoCompleted` — как `notification`.
 * Ближайшее по смыслу событие — это НЕ то же событие, и правило 3 универсальных
 * провайдеров запрещает подменять одно другим. Неизвестное канону событие
 * возвращает `undefined`, и вызывающий называет его пропуском (fail-closed).
 */
const SESSION_EVENT_OF_NAME: Record<string, SessionEvent> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'stop',
  SubagentStop: 'subagent_stop',
  PreCompact: 'pre_compact',
  Notification: 'notification',
};

/**
 * Блокирует ли событие действие — ОТВЕТ КАНОНА, то есть общий по всем CLI.
 *
 * Это ЗАПАСНОЙ ответ, а не главный: блокировка — факт КОНКРЕТНОГО CLI, и берётся
 * она из его записи в каталоге (`hook-events.ts`, `blockingOfEvent(provider,
 * event)`). Сюда разбор приходит только тогда, когда у провайдера такого события
 * не объявлено вовсе — например, хук OpenCode, чьё собственное `file_edited`
 * импортёр приводит к `PostToolUse` канона.
 *
 * Здесь же был источник расхождения, которое нашло ревью волны П1: этот список
 * объявлял `Stop` блокирующим, а справочник событий самого Claude — нет, и тот
 * же файл, перенесённый в тот же CLI, объявлялся потерявшим блокировку. Теперь
 * стороны сравнения одни: справочник Claude исправлен по его документации
 * (`Stop` и `PreCompact` действие останавливают), а факт цели всегда берётся из
 * каталога.
 *
 * Понижение только в сторону строгости (инвариант 6): неизвестное событие
 * считается блокирующим, а не наблюдающим, — ошибка в эту сторону стоит лишней
 * строгости, в обратную — тихо снятого запрета. `PermissionRequest` назван
 * блокирующим по смыслу события: решение о разрешении принимается ДО вызова, и
 * отказ в нём вызов не состоится (у Claude — полем `decision`, а не кодом
 * выхода; способ разный, исход один).
 */
const BLOCKING_EVENTS = new Set([
  'PreToolUse',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'PreCompact',
]);

export function canonBlockingOfEvent(event: string): EnvBlocking {
  if (BLOCKING_EVENTS.has(event)) return 'blocks';
  if (event in TOOL_EVENT_NEEDS || event in SESSION_EVENT_NEEDS) return 'observes';
  return 'blocks';
}

/** Факты, которые событие задаёт самим своим существованием. */
export function declaredNeedsOfEvent(event: string): readonly EnvNeed[] {
  return TOOL_EVENT_NEEDS[event] ?? SESSION_EVENT_NEEDS[event] ?? [];
}

// --- Статический разбор скрипта ---------------------------------------------

/**
 * Поля нагрузки, которые ищем в тексте скрипта. Ключ — имя поля так, как его
 * пишут все три формы доступа (`.tool_name`, `["tool_name"]`, `$tool_name`,
 * `jq .tool_name`), значение — факт канона.
 */
const PAYLOAD_FIELDS: Record<string, EnvNeed> = {
  tool_name: 'tool_name',
  toolName: 'tool_name',
  tool_input: 'tool_input',
  toolInput: 'tool_input',
  tool_response: 'tool_result',
  tool_result: 'tool_result',
  toolResult: 'tool_result',
  prompt: 'prompt',
  user_prompt: 'prompt',
  transcript_path: 'transcript',
  transcript: 'transcript',
  cwd: 'cwd',
  session_id: 'session_id',
  sessionId: 'session_id',
  subagent_type: 'subagent',
  agent_name: 'subagent',
  trigger: 'compact',
  custom_instructions: 'compact',
};

/**
 * Признаки того, что нагрузку разобрать нельзя. Каждый из них означает: скрипт
 * может прочитать что угодно, и обещать переносимость по его тексту было бы
 * выдумкой.
 */
const UNDETERMINED_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    // `payload[key]`, `input[$1]`, `data[var]` — имя поля считается в рантайме.
    pattern: /\b(?:payload|input|data|event|hook|json)\s*\[\s*[^'"\]\s][^\]]*\]/,
    why: 'скрипт обращается к нагрузке по вычисляемому ключу',
  },
  {
    pattern:
      /\b(?:source|\.)\s+[^\s;|&]+\.(?:sh|bash)\b|\b(?:bash|sh|node|python3?|pwsh)\s+[^\s;|&]+\.(?:sh|bash|js|mjs|cjs|py|ps1)\b/,
    why: 'скрипт вызывает другой скрипт — его нагрузка отсюда не видна',
  },
  {
    pattern: /transcript_path|\.jsonl\b/,
    why: 'скрипт читает транскрипт, а значит может прочитать что угодно из разговора',
  },
  {
    pattern: /\beval\b|\bexec\s*\(/,
    why: 'скрипт исполняет вычисляемый код',
  },
];

/**
 * Поле ищется ФОРМОЙ ДОСТУПА, а не словом. Целого слова мало: скрипт, где
 * `trigger` встретился в комментарии или в имени своей переменной, объявлял факт
 * `compact` — требование, которого у перехватчика нет, а по `needs` матрица
 * ВЫЧИСЛЯЕТ уровень верности, и лишний факт занижает его переносимому хуку.
 *
 * Четыре формы, и все они настоящие обращения к нагрузке:
 *
 *  - `.tool_name`, `$tool_name`, `jq .tool_name` — точка или доллар перед именем;
 *  - `payload["tool_name"]`, `data.get('tool_name')` — имя строковым литералом;
 *  - `const { tool_name } = input` — разбор объекта по имени поля.
 *
 * Форма разбора включена НАРОЧНО, хотя фигурные скобки ловят и комментарий вида
 * `{ trigger }`: недосказанный факт завышает верность переноса, лишний — только
 * занижает, а ошибаться здесь положено в сторону строгости (инвариант 6).
 */
function accessPattern(field: string): RegExp {
  const word = `(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`;
  return new RegExp(
    [
      `[.$]\\s*${field}(?![A-Za-z0-9_])`,
      `['"\`]${field}['"\`]`,
      `\\{[^{}\\n]*${word}[^{}\\n]*\\}`,
    ].join('|'),
  );
}

/** Что статический разбор смог сказать о скрипте. */
export type StaticNeeds =
  | { readonly kind: 'facts'; readonly facts: readonly EnvNeed[] }
  | { readonly kind: 'undetermined'; readonly why: string };

/**
 * Разобрать текст скрипта. Возвращает ГИПОТЕЗУ: список полей, обращение к
 * которым видно в тексте. Формально это не доказательство — доказывает только
 * живой прогон, — поэтому вызывающий обязан пометить результат как `static`.
 */
export function inferNeedsFromScript(text: string): StaticNeeds {
  for (const { pattern, why } of UNDETERMINED_PATTERNS) {
    if (pattern.test(text)) return { kind: 'undetermined', why };
  }

  const facts = new Set<EnvNeed>();
  for (const [field, need] of Object.entries(PAYLOAD_FIELDS)) {
    if (accessPattern(field).test(text)) facts.add(need);
  }
  return { kind: 'facts', facts: [...facts] };
}

/** Больше этого скрипт не читается: разбор — не просмотр дампов. */
const MAX_SCRIPT_BYTES = 512_000;

/** Почему скрипт не прочитан — текст для `undetermined`, а не тихий пропуск. */
function unreadable(scriptPath: string, detail: string): StaticNeeds {
  return { kind: 'undetermined', why: `скрипт ${scriptPath} не прочитан: ${detail}` };
}

/** Прочитать скрипт с диска и разобрать. Нечитаемый скрипт → `undetermined`. */
export function inferNeedsFromScriptFile(scriptPath: string): StaticNeeds {
  let size: number;
  try {
    const stat = statSync(scriptPath);
    if (!stat.isFile()) return unreadable(scriptPath, 'это не обычный файл');
    size = stat.size;
  } catch (error) {
    return unreadable(scriptPath, error instanceof Error ? error.message : String(error));
  }
  if (size > MAX_SCRIPT_BYTES) return unreadable(scriptPath, 'файл слишком велик для разбора');
  try {
    return inferNeedsFromScript(readFileSync(scriptPath, 'utf8'));
  } catch (error) {
    return unreadable(scriptPath, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Собрать `needs` хука из трёх источников по правилу «слабейший не
 * достаточен».
 *
 * - наблюдение есть → факты наблюдения плюс объявленные событием, `observed`;
 * - скрипта нет (команда встроенная) → только объявленное событием, `declared`;
 * - скрипт разобран → объявленное плюс найденное, но помечено `static`: это
 *   гипотеза, и матрица обязана знать, что это гипотеза;
 * - разобрать не удалось → `undetermined` с причиной.
 */
export function resolveHookNeeds(params: {
  event: string;
  scriptPath: string | null;
  observed?: readonly EnvNeed[];
}): EnvNeeds {
  const declared = declaredNeedsOfEvent(params.event);

  // Наблюдение считается наблюдением, только если оно что-то наблюдало. Пустой
  // массив здесь проходил как истинный, и объявленные СОБЫТИЕМ факты уезжали с
  // меткой `observed` — слабейшее свидетельство под именем сильнейшего. Пустой
  // прогон не отличим от прогона, где перехватчик не сработал, поэтому запись
  // остаётся на статическом разборе ниже.
  if (params.observed && params.observed.length > 0) {
    return needsFacts([...declared, ...params.observed], 'observed');
  }

  if (!params.scriptPath) {
    if (declared.length === 0) {
      return needsUndetermined(
        `событие «${params.event}» не описано ни у одного известного формата: нагрузка неизвестна`,
      );
    }
    return needsFacts(declared, 'declared');
  }

  const parsed = inferNeedsFromScriptFile(params.scriptPath);
  if (parsed.kind === 'undetermined') return needsUndetermined(parsed.why);

  const merged = [...declared, ...parsed.facts];
  if (merged.length === 0) {
    return needsNone('ни событие, ни текст скрипта не называют ни одного факта рантайма');
  }
  return needsFacts(merged, 'static');
}
