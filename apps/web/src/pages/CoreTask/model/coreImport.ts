import { scopeOf, type Group } from '@agentdeck/contracts';
import type { FromPathBody } from '@agentdeck/contracts/core/panel-api';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import type { LaunchDraft } from '@features/CoreLaunch';

/**
 * Перевод прежней группы в ядро (этап 10, F1): «Путь» группы → сценарий библиотеки ядра той же
 * миграцией `fromPath`, что у ядра (P100). Чистые правила — здесь, чтобы их держал тест, а не глаз:
 * какой id получит сценарий, какую версию, и что из группы попадёт в запуск.
 */

const ID_MAX = 64;

/** id сценария библиотеки ядра (slug `^[a-z0-9][a-z0-9-]{0,63}$`) — от id группы, стабильный. */
export function coreScenarioId(groupId: string): string {
  const slug = groupId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `group-${slug || 'x'}`.slice(0, ID_MAX).replace(/-$/, '');
}

/**
 * Тело `POST /v1/scenarios/from-path`: свои шаги «Пути», а у группы без них — старый «Порядок
 * работы». `lang` — язык интерфейса: ядро называет на нём и стадии, и свои шаги (без смеси языков).
 */
export function fromPathBody(group: Group, lang: string): FromPathBody {
  const steps = group.path?.steps ?? [];
  const legacy = group.scenario?.steps ?? [];
  return {
    id: coreScenarioId(group.id),
    title: group.name.slice(0, 400),
    lang: lang.startsWith('en') ? 'en' : 'ru',
    ...(group.flow ? { flow: group.flow } : {}),
    ...(steps.length > 0 ? { path: { steps } } : {}),
    ...(steps.length === 0 && legacy.length > 0
      ? {
          legacy: {
            steps: legacy.map((s) => ({ title: s.title, body: s.body ?? '', gate: s.gate ?? '' })),
          },
        }
      : {}),
  };
}

/** JSON с упорядоченными ключами: сравнение сценариев не зависит от порядка полей в ответе. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameContent(a: Scenario, b: Scenario): boolean {
  return stableJson({ ...a, version: 0 }) === stableJson({ ...b, version: 0 });
}

/**
 * Куда ляжет перевод. Запись библиотеки однократна (F6): тот же сценарий уже есть — берём его
 * версию и ничего не пишем (повторный перевод той же группы не плодит версии); иначе — следующая
 * за последней версией этого id.
 */
export function placeInLibrary(
  scenario: Scenario,
  library: readonly Scenario[],
): { ref: ScenarioRef; save: Scenario | null } {
  const same = library.filter((s) => s.id === scenario.id);
  const existing = same.find((s) => sameContent(s, scenario));
  if (existing) return { ref: { id: existing.id, version: existing.version }, save: null };
  const version = same.reduce((max, s) => Math.max(max, s.version), 0) + 1;
  return { ref: { id: scenario.id, version }, save: { ...scenario, version } };
}

/**
 * Начальный черновик запуска со сценарием группы. Ядро прежние запуски не подхватывает (Q10,
 * спека 10:8): из группы берутся только её имя и её собственный проект (у проектной группы) —
 * ни копия, ни ветка, ни запрос прежнего запуска сюда не попадают.
 */
export function launchInitialOf(group: Group, ref: ScenarioRef): Partial<LaunchDraft> {
  const scope = scopeOf(group);
  return {
    title: group.name.slice(0, 200),
    scenario: { kind: 'library', id: ref.id, version: ref.version },
    ...(scope.kind === 'project' ? { repos: [{ path: scope.path, baseRef: '' }] } : {}),
  };
}
