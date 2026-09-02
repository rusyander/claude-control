import type { ChatSummary } from '@claude-control/contracts';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';

/** Настройки прогона, с которыми уходит ответ ребёнку. */
export interface AnswerChildOptions {
  allowEdits: boolean;
  autoApprove: boolean;
  model: string;
  effort: string;
}

/**
 * Ответ на вопрос дочернего разговора, отправленный ИЗ РОДИТЕЛЯ.
 *
 * Канал один — обычное сообщение в чат ребёнка. «Ответить в сам вызов» не
 * существует: `AskUserQuestion` в пакетном режиме возвращается ошибкой сразу
 * (замерено, см. `QUESTION_PROMPT` на сервере), и агент к моменту клика уже
 * работает дальше. Поэтому занятому ребёнку ответ уходит В ОЧЕРЕДЬ и доедет,
 * как только он закончит ход, а свободному — сразу, продолжая его сессию.
 *
 * Тумблеры (правки, автоподтверждение, модель, глубина) берутся родительские:
 * своих у ребёнка в этой вкладке нет, а разговор идёт в том же проекте той же
 * панели. Каталог — ЕГО собственный: ребёнок разделения работает в копии
 * репозитория, и отправить его работать в родительскую было бы подменой ветки.
 */
export function answerChild(
  chatId: string,
  answer: string,
  input: {
    chats: ChatSummary[];
    runs: ActiveRunView[];
    options: AnswerChildOptions;
  },
): void {
  const prompt = answer.trim();
  if (!prompt) return;

  const run = input.runs.find((item) => item.id === chatId);
  const chat = input.chats.find(
    (item) => item.id === chatId || (run?.sessionId && item.id === run.sessionId),
  );

  if (run?.status === 'running') {
    agentRuns.enqueue(chatId, { prompt, files: [], ...input.options });
    return;
  }

  void agentRuns.start({
    chatId,
    prompt,
    // Продолжаем сессию ребёнка, а не заводим ему новую.
    sessionId: run?.sessionId ?? (chat && !chat.isSandbox ? chat.id : undefined),
    files: [],
    ...input.options,
    ...(chat && !chat.isSandbox && chat.projectPath ? { projectPath: chat.projectPath } : {}),
  });
}
