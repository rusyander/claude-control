import type { PathAnchor } from '@agentdeck/contracts';

/**
 * Единственный ряд сценария. Стадий у сценария нет, и все его шаги стоят под
 * одной — той же, под которую их пишет агент панели (`actions-groups`). Место
 * шага — только номер в этом ряду.
 */
export const SCENARIO_ANCHOR: PathAnchor = 'work';
