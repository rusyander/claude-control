import type { CoreContourRoutes } from '../../platform/routing/core-contour.ts';
import type { ForeignCarryResolver } from '../core-foreign/foreign-carry.ts';
import type { CarryOutcome } from './session-carry.ts';

/**
 * Слой панели для чата ядра, начатого из веба (этап 10, G13): ручка `/api/chat/core-start`
 * спрашивает здесь, что дописать к оценке. Claude — сборка реестра чата (`ChatRunRegistry.carryFor`:
 * то, что прежний исполнитель панели давал разговору Claude); чужой CLI — перенос G6
 * (`createForeignCarry`: строка о тестах и набор этого CLI), локальность — по маршруту контура
 * того же потребителя `foreign:<cli>`, что у продолжения разговора (`handoff-routes.ts`).
 */

export type ChatStartCarry = (input: { cli: string; cwd: string }) => CarryOutcome;

export interface ChatStartCarryDeps {
  claude(cwd: string): CarryOutcome;
  foreign: ForeignCarryResolver;
  /** Маршрут контура потребителя `foreign:<cli>`; нет — контур этот разговор не ведёт. */
  foreignRoutes(cli: string): CoreContourRoutes | undefined;
}

export function createChatStartCarry(deps: ChatStartCarryDeps): ChatStartCarry {
  return ({ cli, cwd }) => {
    if (cli === 'claude') return deps.claude(cwd);
    const routes = deps.foreignRoutes(cli);
    return deps.foreign({ cli, cwd, ...(routes?.length ? { routes } : {}) });
  };
}
