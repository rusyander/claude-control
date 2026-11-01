import type { Scenario, ScenarioRef, StepDef } from '@agentdeck/contracts/core/scenario';
import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import type { SessionStatePort } from '../api/session-state.types.ts';
import { sessionStateDoc, type StateDocOutcome } from '../conductor/state-doc/state-doc.ts';
import { libraryFile, parseScenarioText, presetOf } from '../conductor/scenario/index.ts';
import type { LiveTask } from '../journal/resume.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import type { RoadStart } from './session-road/road.types.ts';

/**
 * `agentdeck state` (03:81-82, G8): ядро — источник правды (`GET /v1/session/state` по токену
 * сессии), снимок запуска — запасной путь самой команды, когда ядро недоступно (`state.json`
 * сессии, `source: 'snapshot'`). Оба собирает `conductor/state-doc` над свёрткой задачи — одна
 * форма документа. Шов загрузки: `createSessionStatePort` → `BootApiDeps.sessionState`,
 * `launchSnapshot` → `RoadDeps.sessionState`; общий `scenarioOf` — `libraryScenarioOf(<дом>/scenarios)`.
 */

export interface SessionStateDeps {
  /** Сценарий по ссылке — пресет или версия библиотеки (синхронно: ручка и дорога синхронны). */
  scenarioOf(ref: ScenarioRef): Scenario | undefined;
}

const keyOf = (ref: ScenarioRef): string => `${ref.id}@${ref.version}`;

/**
 * Пресет, иначе версия библиотеки человека. Версия пишется один раз (G11) — прочитанная
 * запоминается; отсутствие и сбой чтения не запоминаются: файл может появиться позже.
 */
export function libraryScenarioOf(dir: string): SessionStateDeps['scenarioOf'] {
  const known = new Map<string, Scenario>();
  return (ref) => {
    const preset = presetOf(ref);
    if (preset) return preset;
    const had = known.get(keyOf(ref));
    if (had) return had;
    const got = readBytesSync(libraryFile(dir, ref));
    if (!('value' in got)) return undefined;
    const parsed = parseScenarioText(got.value.toString('utf8'));
    if (!parsed.ok || keyOf(parsed.scenario) !== keyOf(ref)) return undefined;
    known.set(keyOf(ref), parsed.scenario);
    return parsed.scenario;
  };
}

/**
 * Определение шага: та версия сценария задачи, где есть `stepDefId` шага — действующая, исходная,
 * затем ожидающая правки (тот же порядок ссылок, что у исполнителя).
 */
export function stepDefOf(
  state: TaskFoldState,
  stepId: string,
  scenarioOf: SessionStateDeps['scenarioOf'],
): StepDef | null {
  const rec = Object.hasOwn(state.steps, stepId) ? state.steps[stepId] : undefined;
  if (!rec) return null;
  for (const ref of [state.scenario?.ref, state.created?.scenario, state.scenario?.pending?.to]) {
    const def = ref ? scenarioOf(ref)?.steps.find((d) => d.id === rec.stepDefId) : undefined;
    if (def) return def;
  }
  return null;
}

function docOf(
  state: TaskFoldState,
  stepId: string,
  source: SessionStateDoc['source'],
  deps: SessionStateDeps,
): StateDocOutcome {
  return sessionStateDoc({ state, stepId, def: stepDefOf(state, stepId, deps.scenarioOf), source });
}

/** Порт ручки: сессию и её шаг называет токен (`binding`), документ — из живой свёртки. */
export function createSessionStatePort(deps: SessionStateDeps): SessionStatePort {
  return {
    read(task, binding) {
      return docOf(task.state, binding.stepId, 'core', deps);
    },
  };
}

/**
 * Снимок на запуск для дороги сессии: тот же документ с `source: 'snapshot'`. Не собрался —
 * `undefined`, и запуск пишет в `state.json` неполный снимок с причиной (`launchCli`).
 */
export function launchSnapshot(
  deps: SessionStateDeps,
): (task: LiveTask, start: RoadStart) => SessionStateDoc | undefined {
  return (task, start) => {
    const got = docOf(task.state, start.stepId, 'snapshot', deps);
    return 'value' in got ? got.value : undefined;
  };
}
