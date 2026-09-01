import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@claude-control/contracts/task-split';
import { workspace, projectShortName, normalizeProjectPath } from '@shared/lib/workspace';
import { agentRuns } from '@shared/lib/agent-runs';
import { saveDraft } from '@shared/lib/draft';
import { toast } from '@shared/lib/toast';
import { chatKeys } from '@entities/Chat';
import { projectGitKey } from '@entities/ProjectGit';
import { useSplitTasks, fetchSplitRequestPrompt } from '@entities/ChatSplit';

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
}

export interface TaskSplitApi {
  /** Кнопка «Разделить задачи»: просим агента предложить разделение. */
  askSplit?: () => void;
  /** Согласиться на предложение из карточки. */
  split: (proposal: TaskSplitProposal, options: { startRuns: boolean }) => void;
  /** Отказаться: работаем в этом же разговоре по очереди. */
  keepHere: () => void;
  isPending: boolean;
}

/**
 * Разделение списка задач по нескольким чатам — сторона панели.
 *
 * Работы здесь ровно на «попросить и открыть вкладки»: копии репозитория заводит
 * и агентов запускает сервер одним запросом. Так же это выглядит и с телефона —
 * он ходит тем же маршрутом и получает готовые чаты.
 *
 * Вкладка каждой группы сразу ЗАПОМИНАЕТ свой разговор (`rememberView`): без
 * этого возврат на вкладку показывал бы пустой черновик вместо агента, который
 * в ней работает, — ровно та беда, ради которой заводилась память вкладок.
 */
export function useTaskSplit({
  projectPath,
  parentChatId,
  allowEdits,
  model,
  effort,
  dispatch,
}: TaskSplitInput): TaskSplitApi {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const splitTasks = useSplitTasks();

  const askSplit = (): void => {
    void fetchSplitRequestPrompt()
      .then((prompt) => dispatch(prompt, []))
      .catch(() => toast.error(t('chat.split.askFailed')));
  };

  const keepHere = (): void => {
    void dispatch(t('chat.split.keepHerePrompt'), []);
  };

  const split = (proposal: TaskSplitProposal, options: { startRuns: boolean }): void => {
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
      },
      {
        onSuccess: (result) => {
          for (const chat of result.chats) {
            const tabId = workspace.openProject(chat.path, projectShortName(chat.path));
            workspace.rememberView(tabId, chat.chatId);
            // Прогон не запускали — кладём задание в поле ввода этой вкладки.
            // Ключ черновика у разговора, которого ещё нет, строится по ПУТИ
            // проекта (см. `draftKeyFor`), поэтому он же и здесь.
            if (!chat.started) {
              saveDraft(`project:${normalizeProjectPath(chat.path)}`, chat.prompt);
            }
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
          // Сбой одной группы не откатывает остальные, поэтому о нём говорим
          // отдельной строкой: три чата из четырёх — это результат, а не отказ.
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
        },
        onError: (error) => {
          toast.error(t('chat.split.failedAll', { message: (error as Error).message }));
        },
      },
    );
  };

  return {
    ...(projectPath ? { askSplit } : {}),
    split,
    keepHere,
    isPending: splitTasks.isPending,
  };
}
