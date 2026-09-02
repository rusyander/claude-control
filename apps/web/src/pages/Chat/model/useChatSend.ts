import { useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@claude-control/contracts';
import { agentRuns, type SendOutcome } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../lib/uploads';
import { planSend } from '../lib/send';
import type { ChatSendFile } from '../ChatPage.types';

export interface ChatSendInput {
  /** Разговор или черновик, в который уходит сообщение. */
  chatId?: string;
  /** Id существующего разговора — им продолжается сессия Claude Code. */
  activeChatId?: string;
  /** Сессия, выданная потоком новому разговору. */
  sessionId?: string;
  projectPath?: string;
  isRunning: boolean;
  input: string;
  setInput: (value: string) => void;
  setDraftId: Dispatch<SetStateAction<string | undefined>>;
  setPending: Dispatch<SetStateAction<ChatMessage[]>>;
  allowEdits: boolean;
  autoApprove: boolean;
  /** Модель и глубина продумывания: дефолт из настроек или оверрайд чата. */
  model: string;
  effort: string;
}

export interface ChatSendApi {
  /** Правка своей реплики: текст возвращается в поле, следующая отправка ветвит. */
  editMessage: (text: string) => void;
  /** Отправка готового текста мимо поля ввода — кнопкой «Продолжить», например. */
  dispatch: (prompt: string, files: ChatSendFile[]) => Promise<boolean>;
  /** Отправка из поля ввода; `false` — сообщение не приняли. */
  send: (files: ChatSendFile[]) => Promise<boolean>;
  /** Ответ выбранным вариантом на вопрос агента. */
  answerQuestion: (answer: string) => void;
}

/**
 * Отправка сообщений в чат: очередь при занятом агенте, оптимистичный пузырь,
 * ветвление после правки своей реплики и разбор отказа.
 *
 * Правило, которое здесь держится: набранное принадлежит человеку, пока
 * сообщение не принято, — поле и вложения чистятся только после «да» сервера.
 */
export function useChatSend({
  chatId,
  activeChatId,
  sessionId,
  projectPath,
  isRunning,
  input,
  setInput,
  setDraftId,
  setPending,
  allowEdits,
  autoApprove,
  model,
  effort,
}: ChatSendInput): ChatSendApi {
  const { t } = useTranslation();

  // Правка своего сообщения помечает следующую отправку как ветвление (форк).
  const forkNextRef = useRef(false);
  const editMessage = (text: string): void => {
    forkNextRef.current = true;
    setInput(text);
  };

  /** Текст отказа — по структурному коду сервера, а не по разбору сообщения. */
  const notSentText = (outcome: Extract<SendOutcome, { ok: false }>): string => {
    if (outcome.code === 'run_busy') return t('chat.notSent.busy');
    if (outcome.code === 'unsupported_upload')
      return t('chat.notSent.files', {
        names: (outcome.files ?? []).join(', '),
        supported: SUPPORTED_UPLOAD_EXTENSIONS.join(', '),
      });
    return t('chat.notSent.other', { message: outcome.message });
  };

  // Общий путь отправки: и для поля ввода, и для клика по варианту вопроса.
  // Показываем реплику сразу (pending), продолжаем существующую сессию.
  // Возвращает, ПРИНЯЛ ли сервер сообщение: отказ обязан быть виден и не должен
  // ничего стоить — ни текста в поле, ни оптимистичного пузыря в ленте.
  const dispatch = async (prompt: string, files: ChatSendFile[]): Promise<boolean> => {
    let id = chatId;
    if (!id) {
      id = `new-${Date.now()}`;
      setDraftId(id);
    }

    const pendingId = `pending-${Date.now()}`;
    setPending((current) => [
      ...current,
      {
        id: pendingId,
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        timestamp: new Date().toISOString(),
      },
    ]);

    const resumeSession = activeChatId ?? sessionId;
    // Правка своего сообщения ветвит разговор: отправка после «изменить» уходит
    // в форк сессии, а исходный разговор остаётся нетронутым. Форк осмыслен
    // только при существующей сессии.
    const fork = forkNextRef.current && Boolean(resumeSession);
    forkNextRef.current = false;

    const outcome = await agentRuns.start({
      chatId: id,
      prompt,
      // Продолжаем существующую сессию; у нового чата её ещё нет.
      sessionId: resumeSession,
      files,
      allowEdits,
      autoApprove,
      fork,
      // Модель и глубина: дефолт из настроек или локальный оверрайд чата.
      model,
      effort,
      // Каталог проекта: серверу — рабочая папка нового чата, стору — группировка
      // статусов. У продолжения сессии рабочая папка уже известна.
      projectPath,
    });

    if (!outcome.ok) {
      // Сообщение не дошло ни до агента, ни до транскрипта — убираем пузырь,
      // возвращаем пометку ветвления и говорим человеку, что произошло.
      setPending((current) => current.filter((message) => message.id !== pendingId));
      if (fork) forkNextRef.current = true;
      toast.error(notSentText(outcome));
      return false;
    }
    return true;
  };

  /**
   * Отправка из поля ввода. Текст очищаем ТОЛЬКО после приёма: раньше поле
   * чистилось до запроса, и любой отказ сервера стирал набранное безвозвратно
   * (черновик в localStorage очищался вместе с ним). Ответ `false` — сигнал
   * композеру оставить вложения на месте.
   */
  const send = async (files: ChatSendFile[]): Promise<boolean> => {
    // Неподдерживаемое вложение отсеиваем здесь, а не ответом сервера: только
    // так отказ приходит до того, как композер снял чипы, и человеку не нужно
    // прикладывать файлы заново. Сервер всё равно проверит ещё раз.
    const plan = planSend(input, files);
    if (plan.action === 'ignore') return false;
    if (plan.action === 'reject') {
      toast.error(
        t('chat.notSent.files', {
          names: plan.names.join(', '),
          supported: SUPPORTED_UPLOAD_EXTENSIONS.join(', '),
        }),
      );
      return false;
    }

    // Агент ещё занят — не отказываем, а дописываем в очередь: уйдёт само, как
    // только он закончит текущий ход, в тот же разговор. Прервать чужой ход
    // нельзя (CLI доводит его до конца), но и ждать конца, ничего не сказав,
    // человек не обязан.
    if (isRunning && chatId) {
      agentRuns.enqueue(chatId, {
        prompt: plan.prompt,
        files,
        allowEdits,
        autoApprove,
        model,
        effort,
      });
      setInput('');
      return true;
    }

    const accepted = await dispatch(plan.prompt, files);
    if (accepted) setInput('');
    return accepted;
  };

  /**
   * Клик по варианту в карточке вопроса: отвечаем этим вариантом, продолжая тот
   * же разговор — выбрать можно прямо в чате, не уходя в терминал.
   *
   * ОТВЕЧАТЬ МОЖНО И ПОКА АГЕНТ РАБОТАЕТ. Раньше здесь стоял отказ, а кнопки
   * карточки гасились на время хода — и это ломало ровно тот случай, ради
   * которого карточка существует: `AskUserQuestion` в пакетном режиме сразу
   * возвращает ошибку (см. `QUESTION_PROMPT` на сервере), агент задаёт вопрос
   * ПОСРЕДИ работы и продолжает писать код ещё минуту. Всё это время человек
   * видел «нужен ваш выбор», по которому нельзя щёлкнуть, а к концу хода про
   * вопрос уже никто не помнил. Занятому агенту ответ уходит в очередь — тем же
   * путём, что и обычное сообщение, дописанное в занятый прогон.
   */
  const answerQuestion = (answer: string): void => {
    const prompt = answer.trim();
    if (!prompt) return;
    if (isRunning && chatId) {
      agentRuns.enqueue(chatId, { prompt, files: [], allowEdits, autoApprove, model, effort });
      return;
    }
    void dispatch(prompt, []);
  };

  return { editMessage, dispatch, send, answerQuestion };
}
