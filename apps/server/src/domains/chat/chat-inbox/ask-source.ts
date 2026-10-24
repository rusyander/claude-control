import type { ChatInbox, InboxLaunch, InboxSource } from '@agentdeck/contracts/chat-inbox';

/**
 * Подпись «чей это вопрос» и подробности запуска агента — поверх сводки
 * ожиданий (`buildInbox`). Отдельно от сборки сводки: та строится из трёх
 * источников правды, а подпись — из связей разговоров и реестра, которые знает
 * маршрут; смешать их значило бы протащить реестр в чистый слой сборки.
 *
 * Читают подпись телефон (строка над вопросом) и ответы из Telegram (строка
 * источника в сообщении): вдали от стола «кто спрашивает» решает, отвечать ли.
 */

/** Связь разговора с группой разделения — ровно то, что нужно подписи. */
export interface SourceLink {
  parentChatId?: string;
  title?: string;
  groupIndex?: number;
  stage?: string;
}

export interface AgentDefinition {
  model?: string;
  effort?: string;
}

export interface SourceDeps {
  link: (chatId: string) => SourceLink | undefined;
  /** Имя разговора-родителя группы (его заголовок в связи или в списке). */
  parentTitle?: (parentChatId: string) => string | undefined;
  /** Имя CLI панели — у разговоров вне панели CLI тот же, Claude Code. */
  cliName: string;
  /** Ход заведён панелью под вопрос из фона (`hostBackgroundAsk`, `options.hold`). */
  background?: (runKey: string) => boolean;
  /** Описание агента по типу: модель и усилие, если в вызове их нет. */
  agentDefinition?: (subagentType: string, projectPath: string) => AgentDefinition | undefined;
}

/** Инструменты запуска агента: нынешнее имя и прежнее. */
const LAUNCH_TOOLS = new Set(['Agent', 'Task']);

export function isLaunchTool(toolName: string): boolean {
  return LAUNCH_TOOLS.has(toolName);
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Подробности запуска агента из входа вызова; не запуск — ничего. */
export function launchOf(
  toolName: string,
  input: unknown,
  definition?: (subagentType: string) => AgentDefinition | undefined,
): InboxLaunch | undefined {
  if (!isLaunchTool(toolName)) return undefined;
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const subagentType = text(raw.subagent_type);
  const own = subagentType ? definition?.(subagentType) : undefined;
  const model = text(raw.model) ?? own?.model;
  const effort = text(raw.effort) ?? own?.effort;
  const description = text(raw.description);
  return {
    ...(description ? { description } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(raw.run_in_background === true ? { background: true } : {}),
  };
}

/** Подпись одного разговора сводки. */
export function sourceOf(
  chat: { id: string; sessionId?: string; runKey?: string; outside?: boolean },
  deps: SourceDeps,
): InboxSource {
  const link =
    deps.link(chat.id) ??
    (chat.sessionId ? deps.link(chat.sessionId) : undefined) ??
    (chat.runKey ? deps.link(chat.runKey) : undefined);
  const group =
    link?.parentChatId && typeof link.groupIndex === 'number'
      ? {
          index: link.groupIndex + 1,
          ...(link.title ? { title: link.title } : {}),
          ...(link.stage ? { stage: link.stage } : {}),
          ...(() => {
            const parentTitle = deps.parentTitle?.(link.parentChatId!);
            return parentTitle ? { parentTitle } : {};
          })(),
        }
      : undefined;
  const background = chat.runKey ? deps.background?.(chat.runKey) === true : false;
  return {
    app: chat.outside ? 'outside' : 'agentdeck',
    cli: deps.cliName,
    ...(background ? { background: true } : {}),
    ...(group ? { group } : {}),
  };
}

/** Сводка с подписями разговоров и подробностями запусков агента. Меняет на месте и отдаёт её же. */
export function withSources(inbox: ChatInbox, deps: SourceDeps): ChatInbox {
  for (const chat of inbox.chats) {
    if (chat.asks.length === 0) continue;
    chat.source = sourceOf(chat, deps);
    for (const ask of chat.asks) {
      if (ask.kind !== 'permission') continue;
      const launch = launchOf(ask.toolName, ask.input, (type) =>
        deps.agentDefinition?.(type, chat.projectPath),
      );
      if (launch) ask.launch = launch;
    }
  }
  return inbox;
}
