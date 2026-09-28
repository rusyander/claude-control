import type { InboxAsk, InboxChat, InboxQuestion } from '@agentdeck/contracts/chat-inbox';
// Прямо из модулей стора, а не из `runs/index`: тот тянет транспорт (`expo/fetch`,
// `react-native`), а разбор сводки проверяется тестами без них.
import { runNamed } from '../../shared/lib/runs/store';
import type { AgentRun, StreamedTool } from '../../shared/lib/runs/types';

/**
 * Вопросы из живого потока прогона — рядом со сводкой сервера.
 *
 * Сводка (`GET /chat/inbox`) берёт вопрос из транскрипта и считает его
 * отвеченным по первой реплике «от человека». Но CLI пишет от имени человека и
 * итог фонового субагента (`<task-notification>` строкой) — и вопрос исчезал с
 * телефона, как только субагент хода отчитывался, хотя на столе карточка
 * висела дальше (живой прогон 28.09, 1b). Панель показывает вопрос из потока
 * прогона; телефон этот поток и так держит по каждому идущему ходу (опрос
 * `/chat/active` подхватывает все), поэтому вопрос идущего хода берётся оттуда
 * же — пока ход идёт и вопрос не закрыт автовыбором. Ключ тот же, что у
 * сервера (`q:<вызов>:<номер>`): пришедший от сервера вопрос не удваивается, а
 * отправленный ответ скрывается одинаково.
 */

/** Открытый вопрос потока: `AskUserQuestion`, не закрытый автономией чата. */
function isOpenAsk(tool: StreamedTool): tool is StreamedTool & { id: string } {
  return tool.name === 'AskUserQuestion' && tool.autoPicks === undefined && Boolean(tool.id);
}

/** Тело вызова пишет модель — берём только то, что похоже на вопрос (как сервер). */
export function parseQuestions(raw: string): InboxQuestion[] {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  const out: InboxQuestion[] = [];
  for (const item of list as { [key: string]: unknown }[]) {
    if (!item || typeof item.question !== 'string' || !item.question.trim()) continue;
    const options = Array.isArray(item.options)
      ? (item.options as { [key: string]: unknown }[])
          .filter((option) => option && typeof option.label === 'string' && option.label.trim())
          .map((option) => ({
            label: String(option.label),
            ...(typeof option.description === 'string' && option.description
              ? { description: option.description }
              : {}),
          }))
      : [];
    out.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header ? { header: item.header } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

/** Вопросы идущего хода из его потока. Законченный ход — только сводка сервера. */
export function liveQuestionAsks(run: AgentRun): InboxAsk[] {
  if (run.status !== 'running' || run.tailOnly) return [];
  const asks: InboxAsk[] = [];
  for (const tool of run.tools) {
    if (!isOpenAsk(tool)) continue;
    const questions = parseQuestions(tool.input);
    const askedAt = new Date(tool.at ?? run.startedAt ?? run.lastEventAt).toISOString();
    questions.forEach((question, index) =>
      asks.push({
        kind: 'question',
        key: `q:${tool.id}:${index}`,
        toolUseId: tool.id,
        index,
        total: questions.length,
        question,
        askedAt,
      }),
    );
  }
  return asks;
}

/**
 * Сводка с вопросами живых ходов. Чат, где поток знает вопрос, которого нет в
 * ответе сервера, получает его строкой и статус «ждёт вас»; остальные чаты —
 * те же объекты, что пришли.
 */
export function withLiveAsks(chats: readonly InboxChat[], runs: readonly AgentRun[]): InboxChat[] {
  return chats.map((chat) => {
    const run = runNamed(runs, chat.runKey, chat.sessionId, chat.id);
    if (!run) return chat;
    const known = new Set(chat.asks.map((ask) => ask.key));
    const extra = liveQuestionAsks(run).filter((ask) => !known.has(ask.key));
    if (extra.length === 0) return chat;
    const asks = [...chat.asks, ...extra].sort(
      (a, b) => a.askedAt.localeCompare(b.askedAt) || a.key.localeCompare(b.key),
    );
    const newest = asks.reduce((at, ask) => (ask.askedAt > at ? ask.askedAt : at), chat.updatedAt);
    return { ...chat, asks, status: 'waiting', updatedAt: newest };
  });
}

/** Строка сводки этого разговора — по любому имени, под которым его открыли. */
export function inboxChatNamed(
  chats: readonly InboxChat[],
  ...names: (string | undefined)[]
): InboxChat | undefined {
  const wanted = names.filter((name): name is string => Boolean(name));
  return chats.find((chat) =>
    [chat.id, chat.runKey, chat.sessionId].some((name) => name && wanted.includes(name)),
  );
}
