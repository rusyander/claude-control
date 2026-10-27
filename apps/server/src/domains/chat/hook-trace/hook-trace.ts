import type { ChatMessage, HookTrace } from '@agentdeck/contracts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';

/**
 * Хуки хода — для «следа хода» под ответом.
 *
 * CLI пишет срабатывания хуков в транскрипт служебными строками, которые лента
 * пропускает (`isDialogMessage`): `attachment` вида `hook_success`,
 * `hook_additional_context`, `hook_blocking_error` и `system`/`stop_hook_summary`
 * на конце хода. Здесь они разбираются и садятся на шаг модели, к которому
 * относятся: `PreToolUse`/`PostToolUse` и `Stop` — на шаг, после которого
 * записаны; `SessionStart` и `UserPromptSubmit` пишутся ДО первого шага хода —
 * они ждут его.
 *
 * Хуки `Stop` CLI пишет дважды: строкой `hook_success` у тех, кто что-то
 * напечатал, и общим итогом `stop_hook_summary` по всем (замер 25.10.2026: все
 * 259 строк `hook_success` события Stop повторены в итоге). Поэтому строка Stop
 * только запоминает код выхода, а след даёт итог — иначе каждый такой хук
 * считался бы дважды.
 */

/** Сколько символов добавленного контекста отдавать: для узнавания, не для чтения. */
export const HOOK_CONTEXT_MAX = 600;

/** Запись транскрипта — столько, сколько из неё читают хуки. */
export interface HookRecordLike {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  attachment?: unknown;
  hookInfos?: unknown;
  hookErrors?: unknown;
}

/** События, которые случаются до первого шага хода и ждут его. */
const BEFORE_TURN = new Set(['SessionStart', 'UserPromptSubmit']);
/** События конца хода: их след даёт итог `stop_hook_summary`. */
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
/** Оболочки и интерпретаторы: имя хука — файл, который они запускают. */
const RUNNERS = new Set(['node', 'bun', 'deno', 'tsx', 'python', 'python3', 'bash', 'sh', 'zsh']);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): { [key: string]: unknown } =>
  value && typeof value === 'object' ? (value as { [key: string]: unknown }) : {};

/**
 * Имя хука по его команде: файл без пути и расширения.
 * `node "$HOME"/.claude/hooks/review-report-guard.mjs --stop` → `review-report-guard`.
 */
export function hookNameOf(command: string): string | undefined {
  const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const bare = words.map((word) => word.replace(/["']/g, ''));
  let index = 0;
  while (index < bare.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare[index]!)) index += 1;
  const first = bare[index];
  if (!first) return undefined;
  let file = first;
  if (RUNNERS.has(first.split('/').pop() ?? '')) {
    const script = bare.slice(index + 1).find((word) => !word.startsWith('-'));
    if (script) file = script;
  }
  const base = file.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[A-Za-z0-9]+$/, '') || undefined;
}

/** Начало контекста с маской секретов: маска — до обрезки, чтобы разрез не рассёк ключ. */
function contextOf(content: unknown): string | undefined {
  const text = (Array.isArray(content) ? content.map(str).join('\n') : str(content)).trim();
  if (!text) return undefined;
  return maskSecretsInText(text.slice(0, HOOK_CONTEXT_MAX * 2)).slice(0, HOOK_CONTEXT_MAX);
}

/** След с одними заданными полями: пустые не уходят в ответ. */
function trace(fields: HookTrace): HookTrace {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== false),
  ) as HookTrace;
}

/** Сборщик хуков одного прохода по транскрипту. */
export interface TurnHooks {
  /**
   * Запись — хук: разобрана и посажена на шаг (или отложена до него). `true` —
   * это была строка хука, дальше её смотреть незачем.
   */
  take(record: HookRecordLike, ring: ChatMessage[]): boolean;
  /**
   * В ленту легла новая реплика. Ответ модели забирает отложенные хуки; реплика
   * человека, начавшая новый ход, сбрасывает хуки прошлого хода, не дошедшего до
   * модели (запрос, остановленный `UserPromptSubmit`), — `SessionStart` ждёт дальше.
   */
  placed(message: ChatMessage): ChatMessage;
}

export function createTurnHooks(): TurnHooks {
  let pending: HookTrace[] = [];
  // Строки Stop до итога: код выхода и остановка по команде.
  const stopExit = new Map<string, number>();
  const stopBlocked = new Set<string>();

  const put = (traces: HookTrace[], ring: ChatMessage[]): void => {
    const tail = ring.at(-1);
    for (const item of traces) {
      if (BEFORE_TURN.has(item.event) || tail?.role !== 'assistant') pending.push(item);
    }
    const now = traces.filter((item) => !pending.includes(item));
    if (now.length === 0 || !tail) return;
    ring[ring.length - 1] = { ...tail, hooks: [...(tail.hooks ?? []), ...now] };
  };

  const fromSummary = (record: HookRecordLike): HookTrace[] => {
    const errors = Array.isArray(record.hookErrors) ? record.hookErrors.map(str) : [];
    const infos = Array.isArray(record.hookInfos) ? record.hookInfos.map(obj) : [];
    const traces = infos.map((info) => {
      const command = str(info.command);
      const exit = stopExit.get(command);
      return trace({
        event: 'Stop',
        hookName: 'Stop',
        name: hookNameOf(command),
        durationMs: num(info.durationMs),
        exitCode: exit || undefined,
        blocked:
          stopBlocked.has(command) ||
          errors.some((error) => command !== '' && error.startsWith(`[${command}]`)),
      });
    });
    stopExit.clear();
    stopBlocked.clear();
    return traces;
  };

  const fromAttachment = (raw: unknown): HookTrace[] | undefined => {
    const attachment = obj(raw);
    const kind = str(attachment.type);
    const event = str(attachment.hookEvent);
    const hookName = str(attachment.hookName) || event;
    if (kind === 'hook_additional_context') {
      const context = contextOf(attachment.content);
      return context ? [trace({ event, hookName, context })] : [];
    }
    if (kind === 'hook_success') {
      const command = str(attachment.command);
      const exitCode = num(attachment.exitCode) || undefined;
      if (STOP_EVENTS.has(event)) {
        if (exitCode) stopExit.set(command, exitCode);
        return [];
      }
      return [
        trace({
          event,
          hookName,
          name: hookNameOf(command),
          durationMs: num(attachment.durationMs),
          exitCode,
          context: contextOf(attachment.content),
        }),
      ];
    }
    if (kind === 'hook_blocking_error') {
      const command = str(obj(attachment.blockingError).command);
      if (STOP_EVENTS.has(event)) {
        stopBlocked.add(command);
        return [];
      }
      return [trace({ event, hookName, name: hookNameOf(command), blocked: true })];
    }
    return undefined;
  };

  return {
    take(record, ring) {
      if (record.isSidechain) return false;
      let traces: HookTrace[] | undefined;
      if (record.type === 'system' && record.subtype === 'stop_hook_summary') {
        traces = fromSummary(record);
      } else if (record.type === 'attachment') {
        traces = fromAttachment(record.attachment);
      }
      if (!traces) return false;
      put(traces, ring);
      return true;
    },
    placed(message) {
      if (message.role === 'user') {
        if (!message.midTurn) pending = pending.filter((item) => item.event === 'SessionStart');
        return message;
      }
      if (pending.length === 0) return message;
      const hooks = [...(message.hooks ?? []), ...pending];
      pending = [];
      return { ...message, hooks };
    },
  };
}
