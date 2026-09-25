import type { ChatSummary } from '@agentdeck/contracts';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';

/** Настройки прогона, с которыми уходит ответ ребёнку. */
export interface AnswerChildOptions {
  allowEdits: boolean;
  /** Не задан — ребёнок идёт за своим выбором авторежима или глобальной настройкой. */
  autoApprove?: boolean;
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
 * Тумблеры (правки, модель, глубина) берутся родительские: своих у ребёнка в
 * этой вкладке нет, а разговор идёт в том же проекте той же панели. Авторежим —
 * нет: он у ребёнка свой и живёт на сервере (выбор в его чате или глобальная
 * настройка), и родительский выбор не решение про ребёнка. Каталог — ЕГО собственный: ребёнок разделения работает в копии
 * репозитория, и отправить его работать в родительскую было бы подменой ветки.
 */
export function answerChild(
  chatId: string,
  answer: string,
  input: {
    chats: ChatSummary[];
    runs: ActiveRunView[];
    options: AnswerChildOptions;
    /**
     * Чем отозваться человеку. Родительская лента ответом не пополняется — ход
     * тратит ребёнок, — и без этой строки выбор проваливается без следа: карточка
     * уезжает сразу, а КОМУ из шестерых ушёл ответ, вспомнить уже нечем.
     */
    notify?: (title: string, queued: boolean) => void;
    /** Сервер ответ не принял: без этого тост «отправлен» врал бы о потерянном ответе. */
    onRefused?: (title: string, message: string) => void;
  },
): void {
  const prompt = answer.trim();
  if (!prompt) return;

  // Вопрос из записи сервера (WP9c) зовёт ребёнка ключом ЧАТА, а вкладка, что
  // его запустила, помнит прогон под черновым `new-…`: без сверки по sessionId
  // занятому ребёнку ушёл бы второй старт вместо очереди — и отказ 409.
  const run = input.runs.find((item) => item.id === chatId || item.sessionId === chatId);
  const chat = input.chats.find(
    (item) => item.id === chatId || (run?.sessionId && item.id === run.sessionId),
  );
  const title = chat?.title || chatId;

  if (run?.status === 'running') {
    agentRuns.enqueue(chatId, { prompt, files: [], ...input.options });
    input.notify?.(title, true);
    return;
  }
  // Тост — по ответу сервера, а не до него: занятого ребёнка, которого
  // вкладка не ведёт, сервер ставит в очередь (202), и «отправлен» было бы
  // неправдой; отказ — тем более.
  void agentRuns
    .start({
      chatId,
      prompt,
      // Продолжаем сессию ребёнка, а не заводим ему новую.
      sessionId: run?.sessionId ?? (chat && !chat.isSandbox ? chat.id : undefined),
      files: [],
      ...input.options,
      ...(chat && !chat.isSandbox && chat.projectPath ? { projectPath: chat.projectPath } : {}),
      // Вкладка не видит прогона ребёнка, но он может идти: отцепленная группа,
      // прогон конвейера или другой вкладки. Тогда ответ ставит в очередь сервер,
      // а не отказ 409 съедает его (W3-5).
      queueIfBusy: true,
    })
    .then((outcome) => {
      if (outcome.ok) input.notify?.(title, outcome.queued === true);
      else input.onRefused?.(title, outcome.message);
    });
}
