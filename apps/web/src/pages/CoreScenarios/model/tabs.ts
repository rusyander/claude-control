/** Вкладки раздела «Сценарии ядра»: ключ памяти вкладки и порядок показа. */
export const CORE_SCENARIOS_PAGE = 'coreScenarios';

export const CORE_SCENARIOS_TABS = ['library', 'new', 'task'] as const;
export type CoreScenariosTab = (typeof CORE_SCENARIOS_TABS)[number];
