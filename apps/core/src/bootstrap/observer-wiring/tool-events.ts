import { createHash } from 'node:crypto';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AdapterEvent, PermissionAsk, RawToolCall } from '../../adapters/adapter.types.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { canonicalPath, effectOf } from './effect-class.ts';
import { fileFp as platformFileFp, type FileFp } from './file-fp.ts';
import type { ObserverTap } from './observer-wiring.types.ts';

/**
 * Кран фактов вызовов (этап 8, зона W): пара `tool.requested` → `tool.result` одного `toolUseId`
 * в потоке сессии → одна строка `tool.event` — сырьё предикатов расточительства. Только факты
 * вызова: класс действия, канонические цель и каталог, отпечаток argv, окно и отпечаток файла,
 * исход из структурного поля CLI (P32: текст модели здесь не судится). Время вызова — рабочее
 * монотонное ядра (без сна машины, P56).
 *
 * Событие из истории прикреплённой заново сессии (`inHistory`) строкой не становится: его факт
 * уже в журнале. Вызов, чья строка уже есть (ядро упало между строкой и концом истории), второй
 * раз не пишется — набор записанных `toolUseId` пересобирается из журнала один раз на задачу.
 */

/** Что кран знает о сессии сверх потока: сопоставление её переходника и каталог сессии. */
export interface ToolEventSession {
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Корень копии сессии; `null` — неизвестен (относительные пути команд тогда не разрешаются). */
  cwd: string | null;
}

export interface ToolEventTapDeps {
  sessionOf(task: LiveTask, binding: SessionBinding): ToolEventSession | undefined;
  /** Рабочее монотонное время ядра (`activeMono`). */
  now(): number;
  fileFp?: (path: string) => FileFp | null;
  /** Строки журнала для пересборки записанных вызовов; по умолчанию файл задачи. */
  history?: (task: LiveTask) => readonly JournalLine[];
  os?: OsKind;
  pollTools?: ReadonlySet<string>;
}

interface Pending {
  name: string;
  input: unknown;
  parentToolUseId: string | null;
  at: number;
}

type ResultEvent = Extract<AdapterEvent, { type: 'tool.result' }>;

/** Предел ждущих вызовов на сессию: результат приходит за вызовом, потерянный не копится вечно. */
const PENDING_MAX = 500;

const callKey = (sessionId: string, toolUseId: string): string => `${sessionId}\u0000${toolUseId}`;
/** Строка отказа CLI — своя рядом со строкой вызова того же id, свой ключ записанного. */
const deniedKey = (sessionId: string, toolUseId: string): string =>
  `${callKey(sessionId, toolUseId)}\u0000denied`;

type AskEvent = Extract<AdapterEvent, { type: 'ask' }>;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** argv каждой команды через NUL, команды — через `NUL;NUL`: одна строка = один отпечаток. */
export const argvDigestOf = (argv: readonly (readonly string[])[]): string =>
  sha256(argv.map((words) => words.join('\u0000')).join('\u0000;\u0000'));

/** Отпечаток текста ошибки: маска DLP, CRLF → LF, без краевых пробелов; пусто — `null`. */
export function errorDigestOf(
  text: string | null | undefined,
  mask: LiveTask['mask'],
): string | null {
  if (!text) return null;
  const clean = mask(text).text.replace(/\r\n/g, '\n').trim();
  return clean === '' ? null : sha256(clean);
}

const asInput = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/** Подпись вызова для человека — не длиннее строки журнала `text`. */
const DISPLAY_MAX = 2_000;

export function createToolEventTap(deps: ToolEventTapDeps): ObserverTap {
  const os = deps.os ?? currentOs();
  const fp = deps.fileFp ?? platformFileFp;
  const history = deps.history ?? ((t: LiveTask) => readJournalLines(t.dir, t.taskId).lines);
  const pending = new Map<string, Map<string, Pending>>();
  const journaled = new WeakMap<LiveTask, Set<string>>();

  /** Записанные вызовы задачи — из журнала один раз на открытую задачу, дальше по своим строкам. */
  const journaledOf = (task: LiveTask): Set<string> => {
    let got = journaled.get(task);
    if (got) return got;
    got = new Set();
    for (const line of history(task)) {
      if (line.kind !== 'tool.event') continue;
      const d = (line as JournalLine<'tool.event'>).data;
      got.add(d.denied ? deniedKey(d.sessionId, d.toolUseId) : callKey(d.sessionId, d.toolUseId));
    }
    journaled.set(task, got);
    return got;
  };

  const pendingOf = (task: LiveTask, sessionId: string): Map<string, Pending> => {
    const key = `${task.taskId}\u0000${sessionId}`;
    let calls = pending.get(key);
    if (!calls) pending.set(key, (calls = new Map()));
    return calls;
  };

  const onResult = (task: LiveTask, binding: SessionBinding, event: ResultEvent): void => {
    const calls = pendingOf(task, binding.sessionId);
    const call = calls.get(event.toolUseId);
    if (!call) return;
    calls.delete(event.toolUseId);
    // Записанный вызов сюда не доходит: его `tool.requested` отсеян по набору записанных.
    const session = deps.sessionOf(task, binding);
    if (!session) return;
    const ask = session.mapPermission({ tool: call.name, input: asInput(call.input) });
    const facts = effectOf(ask, {
      cwd: session.cwd,
      os,
      ...(deps.pollTools ? { pollTools: deps.pollTools } : {}),
    });
    // Окно чтения неизвестно — отпечатка нет: два разных окна одного файла не сочтутся перечитыванием.
    const file =
      facts.effectClass === 'read' && facts.range !== undefined && !event.isError
        ? fp(facts.target)
        : null;
    const outcome = event.outcome;
    task.append({
      kind: 'tool.event',
      actor: `session:${binding.sessionId}`,
      stepId: binding.stepId,
      sessionId: binding.sessionId,
      data: {
        sessionId: binding.sessionId,
        toolUseId: event.toolUseId,
        parentToolUseId: call.parentToolUseId,
        tool: call.name,
        effectClass: facts.effectClass,
        target: facts.target,
        argvDigest: facts.argv ? argvDigestOf(facts.argv) : null,
        cwd: session.cwd === null ? null : canonicalPath(session.cwd, null, os),
        range: facts.range ?? null,
        fileFp: file?.fp ?? null,
        sizeBytes: file?.sizeBytes ?? null,
        isError: event.isError,
        exitCode: outcome?.exitCode ?? null,
        errorDigest: errorDigestOf(outcome?.errorText, task.mask),
        ms: Math.max(0, Math.round(deps.now() - call.at)),
        display: ask.display.slice(0, DISPLAY_MAX),
      },
    });
    journaledOf(task).add(callKey(binding.sessionId, event.toolUseId));
  };

  /**
   * Отказ самого CLI (W P-c): судья ядра его не видел (запрет оверлея в настройках CLI, вопрос
   * о праве без отвечающего) — строка `tool.event` с `denied: true` и фактами из вопроса CLI.
   * Без id вызова отказ ни к чему не привязать и не свести с отказом судьи — строки нет.
   */
  const onDenied = (task: LiveTask, binding: SessionBinding, event: AskEvent): void => {
    const id = event.toolUseId;
    if (!event.denied || id === undefined) return;
    const key = deniedKey(binding.sessionId, id);
    if (journaledOf(task).has(key)) return;
    const session = deps.sessionOf(task, binding);
    if (!session) return;
    const facts = effectOf(event.ask, {
      cwd: session.cwd,
      os,
      ...(deps.pollTools ? { pollTools: deps.pollTools } : {}),
    });
    const call = pendingOf(task, binding.sessionId).get(id);
    task.append({
      kind: 'tool.event',
      actor: `session:${binding.sessionId}`,
      stepId: binding.stepId,
      sessionId: binding.sessionId,
      data: {
        sessionId: binding.sessionId,
        toolUseId: id,
        parentToolUseId: call?.parentToolUseId ?? null,
        tool: event.ask.tool,
        effectClass: facts.effectClass,
        target: facts.target,
        argvDigest: facts.argv ? argvDigestOf(facts.argv) : null,
        cwd: session.cwd === null ? null : canonicalPath(session.cwd, null, os),
        range: facts.range ?? null,
        fileFp: null,
        sizeBytes: null,
        isError: true,
        exitCode: null,
        errorDigest: null,
        ms: 0,
        display: event.ask.display.slice(0, DISPLAY_MAX),
        denied: true,
      },
    });
    journaledOf(task).add(key);
  };

  return {
    onEvent(task, binding, event, meta) {
      // История прикреплённой заново сессии: её вызовы уже в журнале (или потеряны в крахе —
      // тогда недосрабатывание, не двойная строка).
      if (meta.inHistory) return;
      if (event.type === 'tool.requested') {
        if (journaledOf(task).has(callKey(binding.sessionId, event.toolUseId))) return;
        const calls = pendingOf(task, binding.sessionId);
        calls.set(event.toolUseId, {
          name: event.name,
          input: event.input,
          parentToolUseId: event.parentToolUseId ?? null,
          at: deps.now(),
        });
        if (calls.size > PENDING_MAX) {
          const oldest = calls.keys().next().value;
          if (oldest !== undefined) calls.delete(oldest);
        }
      } else if (event.type === 'tool.result') onResult(task, binding, event);
      else if (event.type === 'ask') onDenied(task, binding, event);
    },
  };
}
