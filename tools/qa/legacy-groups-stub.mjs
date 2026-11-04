/**
 * Подмена сетки «Прежние группы» — только чтение (этап 10, F1). Прежний исполнитель групп снят,
 * у сетки остались два запроса: `GET /api/groups` (записи групп) и `GET /api/groups/legacy-runs`
 * (прежние запуски). Подмена отдаёт три группы: проектную, её глобальную копию (пара — одна
 * карточка) и проектную без пары; у проектной и у копии есть свой «Путь» — значит, кнопка «В ядро».
 *
 * Заменила `group-stubs.mjs` (редактор, обнаружение, выбор стороны пары — всё это снято).
 */

/** Какие запросы подменяет этот файл: охрана запросов проверки не считает их ушедшими на стенд. */
export const STUBBED = /\/api\/groups(\/legacy-runs)?(\?|$)/;

const NOW = '2026-09-26T09:00:00.000Z';
const SHOP = 'C:/work/shop';
const SITE = 'C:/work/site';
const PROJECT_SCOPE = { kind: 'project', path: SHOP, provider: 'claude' };

const step = (id, ru, en) => ({ id, title: { ru, en }, body: { ru: '', en: '' } });

function group(patch) {
  return {
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order: 0,
    ...patch,
  };
}

/** Записи групп для подмены; `extra` — дописать свои (сценарий проверки). */
export function legacyGroups(extra = []) {
  const project = group({
    id: 'qa-shop-order',
    name: 'Порядок задачи магазина',
    scope: PROJECT_SCOPE,
    when: 'задача с номером тикета PROJ-',
    members: [
      { kind: 'skill', id: 'ticket-delivery', scope: PROJECT_SCOPE },
      { kind: 'rule', id: 'review-checklist', scope: PROJECT_SCOPE },
    ],
    path: { steps: [step('plan', 'План', 'Plan'), step('work', 'Работа', 'Work')] },
    order: 2,
  });
  const copy = group({
    id: 'qa-shop-order-global',
    name: 'Порядок задачи (общий)',
    origin: { scope: PROJECT_SCOPE, groupId: project.id, hash: 'h-origin', copiedAt: NOW },
    when: 'задача с номером тикета в любом проекте',
    members: [{ kind: 'skill', id: 'ticket-delivery' }],
    path: {
      steps: [
        step('plan', 'План', 'Plan'),
        step('work', 'Работа', 'Work'),
        step('review', 'Ревью', 'Review'),
        step('mr', 'MR', 'MR'),
      ],
    },
    order: 1,
  });
  const site = group({
    id: 'qa-site-docs',
    name: 'Документация сайта',
    scope: { kind: 'project', path: SITE, provider: 'claude' },
    members: [{ kind: 'skill', id: 'docs-writer' }],
    order: 3,
  });
  return [copy, project, site, ...extra];
}

/** Подменить оба запроса сетки; `runs` — прежние запуски (по умолчанию нет). */
export async function installLegacyGroupsStub(page, { groups = legacyGroups(), runs = [] } = {}) {
  await page.route(STUBBED, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: {} });
    if (url.pathname.endsWith('/legacy-runs')) return route.fulfill({ json: { runs } });
    return route.fulfill({ json: groups });
  });
}
