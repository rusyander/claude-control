import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import type { CascadeAssignment, CascadeCeiling } from '@agentdeck/contracts/model-cascade';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { agentRuns } from '@shared/lib/agent-runs';
import { saveDraft } from '@shared/lib/draft';
import { toast } from '@shared/lib/toast';
import { chatKeys } from '@entities/Chat';
import { projectGitKey } from '@entities/ProjectGit';
import { offerPlanCancel, splitLocked } from '@entities/ChatTree';
import {
  useSplitTasks,
  useCascadeRule,
  fetchSplitRequestPrompt,
  declineSplit,
} from '@entities/ChatSplit';

export interface TaskSplitInput {
  /** Каталог проекта: без него делить нечего — копию заводить не из чего. */
  projectPath?: string;
  /** Разговор, в котором согласились на разделение, — корень дерева чатов. */
  parentChatId?: string;
  /** Правки в настоящем проекте разрешены — тумблером из шапки. */
  allowEdits: boolean;
  model: string;
  effort: string;
  /** Отправка готового текста в текущий разговор (просьба и отказ идут ею). */
  dispatch: (prompt: string, files: never[]) => Promise<boolean>;
  /**
   * Дерево этого разговора с сервера: в нём запись конвейера. Идущее разделение
   * держит кнопку так же, как идущий запрос (`splitLocked`, находка 12).
   */
  tree?: ChatTreeView;
}

/** Согласие на разделение: запускать ли прогоны и что человек поменял руками. */
export interface SplitDecision {
  startRuns: boolean;
  /** Номер группы → выбранные человеком модель и глубина. */
  assignments?: Record<number, CascadeAssignment>;
}

export interface TaskSplitApi {
  /** Кнопка «Разделить задачи»: просим агента предложить разделение. */
  askSplit?: () => void;
  /** Согласиться на предложение из карточки. */
  split: (proposal: TaskSplitProposal, options: SplitDecision) => void;
  /** Отказаться: работаем в этом же разговоре по очереди. */
  keepHere: () => void;
  isPending: boolean;
  /**
   * Потолок этого разговора, когда подбор модели в проекте включён; пусто —
   * правило выключено (или проекта нет), и карточка ничего про модели не
   * показывает: все дети поедут на выбранной человеком модели.
   *
   * Считается здесь, а не в карточке: те же две половины потолка уже уходят в
   * запрос разделения, и второй расчёт разошёлся бы с первым — карточка обещала
   * бы одно, а стартовало другое.
   */
  ceiling?: CascadeCeiling;
}

/**
 * Разделение списка задач по нескольким чатам — сторона панели.
 *
 * Работы здесь ровно на «попросить»: копии репозитория заводит и агентов
 * запускает сервер одним запросом. Так же это выглядит и с телефона — он ходит
 * тем же маршрутом и получает готовые чаты.
 *
 * ВКЛАДОК НЕ ЗАВОДИМ. Раньше каждая группа открывала свою вкладку проекта, и
 * разделение на шесть частей превращало один проект в семь — человек оставался
 * с рядом одинаковых вкладок вместо одной задачи. Дети живут деревом под
 * родителем в ЕГО же вкладке (`visibleChats` подмешивает их к своим,
 * `withTree` рисует ветку), а каталог копии берётся из самого разговора
 * (`useChatSession`), поэтому ответ ребёнку уходит работать в его копию.
 */
export function useTaskSplit({
  projectPath,
  parentChatId,
  allowEdits,
  model,
  effort,
  dispatch,
  tree,
}: TaskSplitInput): TaskSplitApi {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const splitTasks = useSplitTasks();
  // Правило проекта: включено по умолчанию, поэтому до ответа считаем его
  // включённым — иначе карточка на долю секунды показывала бы прежний вид и
  // мигала бы чипами при каждом открытии чата.
  const cascade = useCascadeRule(projectPath);

  const askSplit = (): void => {
    // Контекст просьбы = потолок этого разговора: по нему сервер решает, звать
    // ли агента классифицировать группы. Без него кнопка вела бы себя не так,
    // как та же инициатива, дописанная к прогону.
    void fetchSplitRequestPrompt({ path: projectPath, model, effort })
      .then((prompt) => dispatch(prompt, []))
      .catch(() => toast.error(t('chat.split.askFailed')));
  };

  const keepHere = (): void => {
    // Отказ уходит агенту репликой — и одновременно гасит инициативу разговора
    // на сервере. Одной репликой не обойтись: она живёт ровно один ход, а
    // инструкция «предложи разделение» дописывается к каждому прогону, и
    // следующий же предложил бы то же самое.
    if (parentChatId) void declineSplit(parentChatId);
    void dispatch(t('chat.split.keepHerePrompt'), []);
  };

  const split = (proposal: TaskSplitProposal, options: SplitDecision): void => {
    if (!projectPath) return;

    splitTasks.mutate(
      {
        projectPath,
        proposal,
        startRuns: options.startRuns,
        allowEdits,
        model,
        effort,
        // Родитель уезжает на сервер, а не запоминается в браузере: дерево
        // должно быть видно и с телефона, и после чистки кэша.
        ...(parentChatId ? { parentChatId } : {}),
        // Замены человека — отдельным полем от предложения агента: одно
        // действует в обе стороны, другое только вверх.
        ...(options.assignments ? { assignments: options.assignments } : {}),
      },
      {
        onSuccess: (result) => {
          for (const chat of result.chats) {
            // Прогон не запускали — кладём задание в поле ввода САМОГО разговора.
            // Разговор уже заведён сервером, поэтому ключ черновика у него свой
            // (`chat:<id>`, см. `draftKeyFor`), а не по каталогу копии.
            if (!chat.started) {
              saveDraft(`chat:${chat.chatId}`, chat.prompt);
            }

            // Подобранная модель — в пер-чат оверрайд ребёнка. Без этого шапка
            // его вкладки показывала бы общий дефолт и им же отправляла второе
            // сообщение: модель, подобранная под задачу, жила бы ровно один
            // прогон. Ключи те же, что у `useChatModelPrefs`.
            if (chat.model !== undefined) saveDraft(`chat-model:chat:${chat.chatId}`, chat.model);
            if (chat.effort !== undefined)
              saveDraft(`chat-effort:chat:${chat.chatId}`, chat.effort);
          }

          // Прогоны завёл сервер, и своего события у них нет: подхватываем их
          // сразу, не дожидаясь такта опроса, — иначе секунды три вкладки стоят
          // без точки и без живого вывода.
          void agentRuns.resumeActive();
          void queryClient.invalidateQueries({ queryKey: chatKeys.list });
          // Веток и копий в репозитории стало больше — пульт git обязан увидеть.
          void queryClient.invalidateQueries({ queryKey: projectGitKey });

          if (result.chats.length > 0) {
            toast.success(t('chat.split.done', { count: result.chats.length }));
          }
          // Уровни (Т1): чатов ещё нет — первым пошёл разбор, группы заведёт
          // конвейер по его итогу. Молчать нельзя: кнопка нажата, а копий не
          // прибавилось, и без этой строки это читается как отказ.
          if (result.triage) {
            toast.info(
              t(result.triage.started ? 'chat.split.triageStarted' : 'chat.split.triageDeferred'),
              { duration: 8_000 },
            );
          }
          // Сбой одной группы не откатывает остальные, поэтому о нём говорим
          // отдельной строкой: три чата из четырёх — это результат, а не отказ.
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
        },
        onError: (error) => {
          // План этого чата ещё идёт — не тупик, а предложение его отменить.
          if (offerPlanCancel(error, t)) return;
          toast.error(t('chat.split.failedAll', { message: (error as Error).message }));
        },
      },
    );
  };

  return {
    ...(projectPath ? { askSplit } : {}),
    split,
    keepHere,
    isPending: splitLocked(splitTasks.isPending, tree, parentChatId),
    // Правило читается на проект, а потолок — из шапки этого разговора: ровно
    // то, что уедет в запрос. Выключено — поля нет, и карточка про модели молчит.
    ...(projectPath && cascade.data?.enabled !== false ? { ceiling: { model, effort } } : {}),
  };
}
