/** Сценарий задачи (02 §Scenario): пресеты, библиотека, слои 3–5, перенос «Пути», правка. */
export {
  diffScenarios,
  latestTaskScenario,
  planScenarioEdit,
  scenarioForStep,
  type EditFields,
  type EditPlan,
  type EditRefusalCode,
  type ScenarioDiff,
  type TaskScenarioFold,
} from './edit.ts';
export { fromPath, type FromPathResult, type LegacySteps, type PathSource } from './from-path.ts';
export {
  latestVersion,
  libraryFile,
  listLibrary,
  parseScenarioText,
  readLibraryScenario,
  scenarioText,
  writeLibraryScenario,
  type LibraryListing,
  type LibraryRead,
  type LibraryWrite,
} from './library.ts';
export { overlayScenario } from './overlay.ts';
export { isPresetId, latestPresets, presetOf, presetStep, PRESETS } from './presets.ts';
export {
  decideRouting,
  routeStep,
  sessionsOf,
  type RoutingEnv,
  type StepRouting,
} from './route-step.ts';
export {
  PROJECT_SCENARIO_FILE,
  resolveScenario,
  scenarioPrecedence,
  type ResolveDeps,
} from './resolve.ts';
export type * from './scenario.types.ts';
