import {
  estimateFieldsSchema,
  type ChatStartReply,
  type EstimateFields,
} from '@agentdeck/contracts/core/estimate';
import type { CommandDraft } from '@entities/CoreTask';
import type { ChatCli, ChatStartDraft } from './coreChat.types';

/**
 * Новый чат — задача ядра `chat@1` (этап 10, F2): оценка с пресетом `chat` прямо в проекте
 * человека (Q1: начало чата и есть грант на этот корень, `ops: ['edit']`). Заголовок — первая
 * строка сообщения: у чата нет отдельного названия, а список задач ядра без него безымянный.
 */

/**
 * CLI из адреса (`?cli=`): любой id переходника ядра (этап 10, F2, проход 2) — какие CLI ядро
 * запускает, решает ядро, а не список панели: CLI без хука ядра получает отказ по имени на экране
 * чата, а не тихий откат на прежний исполнитель. Здесь — только форма id реестра (P108); пустое,
 * число или чужая форма — нет, форма начнёт с Claude.
 */
const CLI_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function chatCliOf(value: unknown): ChatCli | undefined {
  return typeof value === 'string' && CLI_ID.test(value) ? value : undefined;
}

/**
 * CLI в выборе формы: провайдеры панели по порядку каталога, Claude первым, если его нет в
 * списке (каталог ещё грузится); CLI из адреса, которого нет в каталоге, тоже в списке —
 * выбор человека не подменяется молча.
 */
export function chatCliOptions(providerIds: readonly string[], current: ChatCli): ChatCli[] {
  const ids = providerIds.filter((id) => chatCliOf(id) !== undefined);
  const withClaude = ids.includes('claude') ? ids : ['claude', ...ids];
  return withClaude.includes(current) ? withClaude : [...withClaude, current];
}

const TITLE_MAX = 80;

/** Форма id продолжаемого разговора — та же, что у оценки ядра (`resumeSchema`). */
const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ChatStartProblem = 'project' | 'text' | 'resume';

export function chatTitle(text: string): string {
  const first =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

/**
 * Поля оценки нового чата. Запуск всегда `confirm`: CLI выбирает человек, а без `set-cli`
 * ядро взяло бы самый дешёвый маршрут из всех вошедших CLI — `auto` запустил бы шаг раньше,
 * чем выбор дошёл. Порядок `estimate → set-cli → launch` даёт ровно выбранный CLI.
 */
export function chatFields(
  draft: ChatStartDraft,
): { ok: true; fields: EstimateFields } | { ok: false; problem: ChatStartProblem } {
  const project = draft.project.trim();
  const text = draft.text.trim();
  if (!project) return { ok: false, problem: 'project' };
  if (!text) return { ok: false, problem: 'text' };
  // Негодный id из адреса называется сам, а не тихо превращается в новый разговор.
  if (draft.resume !== undefined && !RESUME_ID.test(draft.resume)) {
    return { ok: false, problem: 'resume' };
  }
  const fields = {
    title: chatTitle(text),
    request: text,
    repos: [{ path: project, baseRef: null }],
    scenario: { preset: 'chat' },
    launchPolicy: 'confirm',
    ciWait: false,
    placement: { kind: 'in-place', grant: { project, ops: ['edit'] } },
    // Продолжение разговора просит выбранный CLI: подтверждает транскрипт только его переходник,
    // а чужой CLI получает отказ ядра по имени, а не новый разговор под видом старого.
    ...(draft.resume ? { resume: { adapter: draft.cli, conversationId: draft.resume } } : {}),
  };
  const parsed = estimateFieldsSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, problem: 'text' };
  return { ok: true, fields: parsed.data };
}

/**
 * Команды после оценки, по порядку: маршрут контура (если панель его решила — `allowedRoutes`
 * ответа старта), выбранный CLI на всю задачу, затем запуск. Маршрут — до CLI, как у хода реестра
 * чата: иначе контур «по возможности» новый разговор не вёл.
 */
export function chatLaunchCommands(
  taskId: string,
  cli: ChatCli,
  routes?: ChatStartReply['allowedRoutes'],
): CommandDraft[] {
  return [
    ...(routes?.length
      ? [
          {
            kind: 'set-route' as const,
            taskId,
            fields: { scope: 'task', scopeId: taskId, allowedRoutes: routes },
          },
        ]
      : []),
    {
      kind: 'set-cli',
      taskId,
      fields: { scope: 'task', scopeId: taskId, adapter: cli, timing: 'now' },
    },
    { kind: 'launch', taskId, fields: {} },
  ];
}
