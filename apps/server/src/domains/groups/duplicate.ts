import { randomUUID } from 'node:crypto';
import type { Group } from '@agentdeck/contracts';
import { groupCopyName, type GroupDuplicateRequest } from '@agentdeck/contracts/groups';
import { assertGroupNameFree } from '../group-draft.ts';
import type { AppStore } from '../../lib/app-store/app-store.ts';

/**
 * «Копировать группу»: независимая запись рядом с оригиналом. Участники — те же
 * ссылки на скиллы, правила, хуки (группа ссылается на файлы, а не держит их),
 * а всё, что живёт в самой записи, — глубокая копия: шаги пути с новыми id,
 * числа, «Когда», ход пути, область, env. Правка копии оригинал не трогает.
 *
 * Не переносятся:
 * - привязка к проектам (`projectPaths`) — она сама включает группу при прогоне
 *   в проекте, и копия ожила бы без спроса рядом с оригиналом;
 * - `origin` — копия не пара проектной группы, слияние с «оригиналом» ей чужое.
 *
 * Копия создаётся выключенной и НИЧЕГО не гасит: запись ложится в state.json
 * без отметок удержания. Обычное сохранение выключенной группы ставит её
 * отметку на каждого участника — а участники здесь общие с оригиналом, и копия
 * выключила бы в конфиге его скиллы и правила. Отметки появятся, только когда
 * человек сам включит и выключит копию.
 */
export function duplicateGroup(
  source: Group,
  options: { name: string; order: number; now: string; makeId?: () => string },
): Group {
  const makeId = options.makeId ?? randomUUID;
  const {
    id: _id,
    origin: _origin,
    projectPaths: _projectPaths,
    ...rest
  } = structuredClone(source);
  return {
    ...rest,
    id: makeId(),
    name: options.name,
    projectPaths: [],
    ...(rest.path
      ? {
          path: {
            steps: rest.path.steps.map((step) => ({
              ...step,
              id: makeId(),
              createdAt: options.now,
            })),
          },
        }
      : {}),
    isEnabled: false,
    order: options.order,
  };
}

/** Копия по запросу маршрута: имя (своё или «(копия N)»), проверка занятости, запись. */
export function saveGroupCopy(
  store: Pick<AppStore, 'getGroups' | 'saveGroup' | 'getSettings'>,
  source: Group,
  request: GroupDuplicateRequest,
  makeId?: () => string,
): Group {
  const groups = store.getGroups();
  const lang = request.lang ?? store.getSettings().language;
  const name =
    request.name ??
    groupCopyName(
      source.name,
      groups.map((group) => group.name),
      lang,
    );
  assertGroupNameFree(groups, name);
  const order = groups.reduce((max, group) => Math.max(max, group.order), -1) + 1;
  const copy = duplicateGroup(source, {
    name,
    order,
    now: new Date().toISOString(),
    ...(makeId ? { makeId } : {}),
  });
  return store.saveGroup(copy);
}
