import type { IntegrationLink, IntegrationLinks } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Привязки проекта к внешнему миру: куда заводить дефекты, где лежат требования,
 * куда публиковать отчёт.
 *
 * Ключ — нормализованный путь проекта, как у остальных карт по проектам:
 * вкладку открывают на любом каталоге, и `C:\Work\Repo` с `c:/work/repo` — это
 * один и тот же проект, а не два.
 *
 * Пустая привязка НЕ хранится: очистка полей должна убирать запись, иначе
 * `state.json` копил бы пустые объекты по каждому каталогу, куда человек
 * заглянул.
 */

/** Пустой каркас: у проекта всегда есть место под привязку и под группы. */
export function emptyLinks(): IntegrationLinks {
  return { project: {}, groups: {} };
}

/** Есть ли в привязке хоть что-то, кроме пустых строк. */
function isBlank(link: IntegrationLink): boolean {
  return Object.values(link).every((value) => value === undefined || value === '');
}

/** Убрать пустые поля: пустая строка из формы — это «не задано», а не значение. */
function clean(link: IntegrationLink): IntegrationLink {
  const result: IntegrationLink = {};
  for (const [key, value] of Object.entries(link)) {
    if (typeof value === 'string' && value.trim()) {
      result[key as keyof IntegrationLink] = value.trim();
    }
  }
  return result;
}

export function getIntegrationLinks(state: AppState, path: string): IntegrationLinks {
  const stored = state.integrationLinks?.[normalizeProjectPath(path)];
  return stored ? structuredClone(stored) : emptyLinks();
}

/** Все привязки разом — списку проектов они нужны одним куском, а не по одной. */
export function getAllIntegrationLinks(state: AppState): Record<string, IntegrationLinks> {
  return structuredClone(state.integrationLinks ?? {});
}

/**
 * Записать привязку проекта или одной его группы. Пустая привязка удаляет
 * запись, а опустевший проект уходит из карты целиком.
 */
export function setIntegrationLink(
  state: AppState,
  path: string,
  groupId: string | undefined,
  link: IntegrationLink,
): IntegrationLinks {
  const key = normalizeProjectPath(path);
  state.integrationLinks ??= {};
  const current = state.integrationLinks[key] ?? emptyLinks();
  const next = clean(link);

  if (groupId) {
    if (isBlank(next)) delete current.groups[groupId];
    else current.groups[groupId] = next;
  } else {
    current.project = next;
  }

  if (isBlank(current.project) && Object.keys(current.groups).length === 0) {
    delete state.integrationLinks[key];
    return emptyLinks();
  }

  state.integrationLinks[key] = current;
  return structuredClone(current);
}

/** Снять привязку: у группы — её собственную, без группы — у самого проекта. */
export function removeIntegrationLink(
  state: AppState,
  path: string,
  groupId?: string,
): IntegrationLinks {
  return setIntegrationLink(state, path, groupId, {});
}
