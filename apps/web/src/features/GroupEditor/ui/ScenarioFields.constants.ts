import type { GroupScenario, ScenarioStep } from '@claude-control/contracts';

/** Пустой шаг — то, что добавляется кнопкой «добавить шаг». */
export const EMPTY_STEP: ScenarioStep = { title: '', body: '', gate: '' };

/** Сценарий у группы необязателен: форма работает с пустым, а не с undefined. */
export const EMPTY_SCENARIO: GroupScenario = { when: '', trigger: '', steps: [] };
