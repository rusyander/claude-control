/** Ворота шага сценария (CD§1): суд `evaluateGates` по типизированным фактам задачи. */
export type * from './gates.types.ts';
export { evaluateGates } from './evaluate.ts';
export { gateFactsOf, type GateLines } from './journal-view.ts';
export {
  INTEGRATION_ROLE,
  INTEGRATION_STEP_IDS,
  INTEGRATION_UNIT_NAME,
  integratedGate,
  integrationHold,
  integrationOf,
  integrationRoundOf,
  integrationSkipOf,
  isIntegrationUnit,
  type IntegratedGate,
} from './integrated.ts';
