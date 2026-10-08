import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type {
  CatalogItemType,
  Group,
  GroupDraft,
  GroupMember,
  LocalizedLine,
  PathEntry,
  PathLang,
  PathStep,
} from '@agentdeck/contracts';
import {
  memberLivesIn,
  pickedMember,
  usePromotePathStep,
  useSaveGroup,
  useSaveGroupPathSteps,
} from '@entities/Group';
import { queryKeys } from '@shared/api/query-keys';
import { customSteps } from './pathEdit';
import { insertAfter } from './insertAfter';

/** Готовый ресурс, который человек выбрал в каталоге. */
export interface PickedResource {
  type: CatalogItemType;
  id: string;
  title?: LocalizedLine;
  /** Откуда ресурс: общий каталог или проект группы. */
  scope?: 'global' | 'project';
}

/** Новый хук из составителя: то, что раньше спрашивала форма «Сценария». */
export interface HookDraft {
  title: string;
  event: string;
  matcher: string;
  command: string;
}

const EMPTY = { ru: '', en: '' };

/**
 * Черновик группы для PUT, собранный так же, как его собирает форма группы:
 * поля, которых форма не касается (путь, числа, копия), сервер сохраняет сам.
 */
function draftWithMember(group: Group, member: GroupMember): GroupDraft {
  return {
    name: group.name,
    description: group.description,
    color: group.color,
    icon: group.icon,
    members: [...group.members, member],
    env: group.env,
    projectPaths: group.projectPaths,
    scenario: group.scenario,
    scope: group.scope,
    flow: group.flow,
    when: group.when,
    isEnabled: group.isEnabled,
  };
}

/**
 * Шаг без разговора с ассистентом: ссылка на готовый ресурс из каталога или
 * новый хук. Шаг встаёт на место «+» (`insertAfter`). Скилл, правило или хук
 * становятся ещё и участниками группы — у сценария и у конвейера: без участия
 * ресурс не включался бы вместе с группой, и шаг «примени скилл X» упирался бы
 * в выключенный скилл. Второго прогона скилла своим блоком у конвейера нет:
 * скилл, стоящий в пути шагом, сервер блоком не рисует (`pathSkills`).
 * Утилита — не участник: её запускают, включать нечего.
 */
export function useQuickStep({
  group,
  entries,
  index,
}: {
  group: Group;
  entries: PathEntry[];
  index: number;
}) {
  const { i18n } = useTranslation();
  const uiLang: PathLang = i18n.language.startsWith('en') ? 'en' : 'ru';
  const save = useSaveGroupPathSteps(group.id);
  const promote = usePromotePathStep(group.id);
  const saveGroup = useSaveGroup();
  const queryClient = useQueryClient();
  /** Какой способ ошибся последним: сбой хука не красит «Выбрать готовый», и наоборот. */
  const [lastAction, setLastAction] = useState<'pick' | 'hook'>('pick');
  /**
   * Группа из списка на миг выбора, а не снимок пропса: второй быстрый выбор,
   * сделанный до перечитывания групп, строился по старому составу и молча
   * терял участника, добавленного первым.
   */
  const latest = (): Group =>
    queryClient.getQueryData<Group[]>(queryKeys.groups)?.find((item) => item.id === group.id) ??
    group;

  const newStep = (title: LocalizedLine, patch: Partial<PathStep>): PathStep => ({
    id: crypto.randomUUID(),
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title,
    prompt: EMPTY,
    source: uiLang,
    createdAt: new Date().toISOString(),
    ...patch,
  });

  const addResource = (item: PickedResource, onDone: () => void): void => {
    setLastAction('pick');
    const title = item.title ?? { ru: item.id, en: item.id };
    const step = newStep(title, {
      kind: 'resource',
      resource: { type: item.type, id: item.id },
    });
    save.mutate(insertAfter(entries, index, step), {
      onSuccess: () => {
        if (item.type !== 'script') {
          const from = item.scope ?? 'global';
          const current = latest();
          const isMember = current.members.some(
            (member) =>
              member.kind === item.type &&
              member.id === item.id &&
              memberLivesIn(current.scope, member) === from,
          );
          if (!isMember) {
            // Окно закрывается, когда участник записан: закрытое раньше давало
            // открыть следующий выбор, пока состав ещё не сохранился.
            saveGroup.mutate(
              {
                id: current.id,
                draft: draftWithMember(
                  current,
                  pickedMember(current.scope, item.type, item.id, from),
                ),
              },
              { onSuccess: onDone },
            );
            return;
          }
        }
        onDone();
      },
    });
  };

  /**
   * Хук создаётся тем же путём, что «сделать шаг хуком»: сначала шаг, затем
   * повышение до хука. Хук не создался — шаг убираем: пустой шаг без хука в
   * пути хуже, чем ничего.
   */
  const addHook = (hook: HookDraft, onDone: () => void): void => {
    setLastAction('hook');
    const step = newStep(hookTitle(hook), {});
    const before = customSteps(entries);
    save.mutate(insertAfter(entries, index, step), {
      onSuccess: () => {
        const draft = JSON.stringify({
          event: hook.event,
          command: hook.command.trim(),
          ...(hook.matcher.trim() ? { matcher: hook.matcher.trim() } : {}),
        });
        promote.mutate(
          { stepId: step.id, type: 'hook', draft },
          { onSuccess: onDone, onError: () => save.mutate(before) },
        );
      },
    });
  };

  /**
   * Название шага-хука на двух языках. Человек пишет на языке окна, а прогон
   * читает английскую сторону: одна строка на обе стороны отдавала модели
   * русский текст. Вторая сторона — событие и условие хука: не перевод, а
   * точное описание того же хука. Английская строка — текст для модели (как
   * промпты сервера), русская — из словаря: русский словарь есть всегда, а
   * английский грузится, только когда окно на английском.
   */
  const hookTitle = (hook: HookDraft): LocalizedLine => {
    const own = hook.title.trim();
    const event = hook.event;
    const matcher = hook.matcher.trim();
    const en = `Hook ${event}${matcher ? ` (${matcher})` : ''}`;
    const ru = i18n.getFixedT('ru')(
      matcher ? 'groupPath.hookStepTitleMatcher' : 'groupPath.hookStepTitle',
      { event, matcher },
    );
    return uiLang === 'ru' ? { ru: own || ru, en } : { ru, en: own || en };
  };

  const error = save.error ?? promote.error ?? saveGroup.error;
  return {
    addResource,
    addHook,
    isPending: save.isPending || promote.isPending || saveGroup.isPending,
    error,
    /** Способ, чей сбой показывать; без сбоя — `undefined`. */
    failedIn: error ? lastAction : undefined,
  };
}
