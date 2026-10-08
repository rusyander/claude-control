import type { AnyPanelAction } from '../registry.ts';
import { TESTS_READ_ACTIONS } from '../actions-tests-reads.ts';
import { TESTS_PLAN_ACTIONS } from '../actions-tests-plans.ts';
import { TESTS_MANUAL_ACTIONS } from '../actions-tests-manual.ts';
import { TESTS_SETUP_ACTIONS } from '../actions-tests-setup.ts';
import { registeredOnly } from '../tests-block-kit.ts';

/**
 * Блок «Тестирование» целиком сверх первого набора (`actions-tests.ts`,
 * `actions-tests-library.ts`, часть `actions-work.ts`): отчёты, планы, ручной
 * прогон, эталоны, автотесты папки e2e, обвязка библиотеки. В реестр — одним
 * разворотом: общий список действий правят параллельно.
 */
export const TESTS_BLOCK_ACTIONS: readonly AnyPanelAction[] = [
  ...TESTS_READ_ACTIONS,
  ...TESTS_PLAN_ACTIONS,
  ...TESTS_MANUAL_ACTIONS,
  ...TESTS_SETUP_ACTIONS,
].map((action) => registeredOnly(action));
