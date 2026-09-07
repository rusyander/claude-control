import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@shared/lib/workspace';
import { agentRuns } from '@shared/lib/agent-runs';
import { chatKeys } from '@entities/Chat';
import type { ProjectInfo } from '@entities/Project';
import type { ParallelChoice } from '@features/ParallelLaunch';

export interface ParallelLaunchInput {
  /** Модель и глубина продумывания, с которыми уйдут все прогоны разом. */
  model: string;
  effort: string;
  /**
   * Разговор, из которого запускают. Становится родителем каждого прогона:
   * настоящий ключ, а не черновик, — под ним чат стоит в списке.
   */
  parentChatId?: string;
}

export interface ParallelLaunchApi {
  isParallelOpen: boolean;
  setParallelOpen: (open: boolean) => void;
  launchParallel: (
    selected: ProjectInfo[],
    prompt: string,
    editsAllowed: boolean,
    choice?: ParallelChoice,
  ) => void;
}

/**
 * Один запрос в нескольких проектах разом.
 *
 * ВКЛАДОК НЕ ЗАВОДИМ — ровно по той же причине, по какой их не заводит
 * разделение задач. Раньше каждый выбранный проект открывал свою вкладку, и
 * запуск по трём проектам превращал рабочее место в четыре вкладки, между
 * которыми человек искал, кто из агентов встал и чего ждёт. Хуже того, вопрос
 * агента и запрос прав жили только в ЕГО вкладке: со стороны это выглядело
 * зависшим прогоном, а на деле работа стояла на невидимом вопросе.
 *
 * Теперь запущенные висят ветвями под тем разговором, из которого их запустили
 * (`parentChatId` уходит на сервер вместе с прогоном и записывается ДО его
 * старта), а всё, что их держит, показывается в родителе — вопросы и права,
 * как у разделения (`useChildHub`).
 *
 * Родителя может и не быть: на домашней вкладке запускают и не выбрав
 * разговора. Тогда вкладку открываем по-старому — иначе прогон не виден нигде,
 * кроме пульта агентов, и «не заводим вкладок» превращается в «потеряли агента».
 */
export function useParallelLaunch({
  model,
  effort,
  parentChatId,
}: ParallelLaunchInput): ParallelLaunchApi {
  const queryClient = useQueryClient();
  const ws = useWorkspace();
  const [isParallelOpen, setParallelOpen] = useState(false);

  const launchParallel = (
    selected: ProjectInfo[],
    prompt: string,
    editsAllowed: boolean,
    choice?: ParallelChoice,
  ): void => {
    const stamp = Date.now();
    selected.forEach((project, index) => {
      if (!parentChatId) ws.openProject(project.path, project.name);
      void agentRuns.start({
        chatId: `new-${stamp}-${index}`,
        prompt,
        projectPath: project.path,
        allowEdits: editsAllowed,
        // Выбор в окне веера сильнее шапки чата: человек решает про этот запуск,
        // глядя на то, сколько агентов стартует. Нет выбора (подбор недоступен —
        // потолок не распознан) — уходит пара разговора, как и раньше.
        model: choice?.model ?? model,
        effort: choice?.effort ?? effort,
        // Понижение отмечаем явно: по этой отметке сервер разворачивает алиас
        // ступени в свежую модель семейства и дописывает заданию планку сдачи.
        ...(choice?.lowered ? { lowered: true } : {}),
        // Имя проекта — подпись ветви: у прогона, начатого не с реплики
        // человека, заголовка ещё нет, и в дереве он был бы безымянным ключом.
        ...(parentChatId ? { parentChatId, parentTitle: project.name } : {}),
      });
    });
    setParallelOpen(false);
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
  };

  return { isParallelOpen, setParallelOpen, launchParallel };
}
