import type { StreamedTool, AgentRun } from '../../shared/lib/runs/types';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { parseQuestions } from './liveAsks';

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
export function isOpenAsk(tool: StreamedTool): tool is StreamedTool & { id: string } {
  return tool.name === 'AskUserQuestion' && tool.autoPicks === undefined && Boolean(tool.id);
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
