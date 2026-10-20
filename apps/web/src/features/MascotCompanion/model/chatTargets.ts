import type { ChatSummary } from '@agentdeck/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChatTarget, CompanionLists } from './chatTargets.types';

/** Короткое имя каталога — последняя часть пути (как у вкладок проектов). */
function shortName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * Куда вести человека по прогону и как его назвать. Имя — заголовок разговора,
 * если список его знает (прогон и разговор сходятся по id или по sessionId),
 * иначе имя каталога; ни того ни другого — пусто, текст скажет «агент».
 */
export function runTarget(
  run: { id: string; sessionId?: string; projectPath?: string },
  chats: ChatSummary[],
): ChatTarget {
  const chat = chats.find((item) => item.id === run.id || item.id === run.sessionId);
  const projectPath = chat?.projectPath ?? run.projectPath;
  return {
    chatId: chat?.id ?? run.sessionId ?? run.id,
    name: chat?.title || (projectPath ? shortName(projectPath) : ''),
    ...(projectPath ? { projectPath } : {}),
    ...(chat?.isSandbox ? { isSandbox: true } : {}),
  };
}

/** Разговор, ждущий ответа, — цель как есть. */
export function chatTarget(chat: ChatSummary): ChatTarget {
  return {
    chatId: chat.id,
    name: chat.title,
    projectPath: chat.projectPath,
    ...(chat.isSandbox ? { isSandbox: true } : {}),
  };
}

/**
 * Три списка сводки. Ждущие — из `useAwaitingChats` (транскрипт + память
 * сервера: вопрос чужого агента тоже виден), поэтому ждущие прогоны в «работают»
 * не попадают дважды. Упавшие и работающие — из прогонов панели.
 */
export function companionLists(
  runs: ActiveRunView[],
  awaiting: ChatSummary[],
  chats: ChatSummary[],
): CompanionLists {
  return {
    waiting: awaiting.map(chatTarget),
    errors: runs.filter((run) => run.status === 'error').map((run) => runTarget(run, chats)),
    running: runs
      .filter((run) => run.status === 'running' || run.status === 'quiet')
      .map((run) => runTarget(run, chats)),
  };
}
