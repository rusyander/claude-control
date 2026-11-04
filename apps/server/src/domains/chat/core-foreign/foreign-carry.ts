import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';
import { coreGatewayRouteId } from '../../platform/routing/core-contour.ts';
import { buildCarry, carriedEnvOf, type CarryOutcome } from '../core-run/session-carry.ts';
import type { CoreForeignStart } from './core-foreign-start.ts';

/**
 * Перенос слоя панели в разговор чужого CLI через ядро (этап 10, G6): строка о блоке «Тесты» и
 * набор панели для этого CLI (`KitService.runExtras`) — то, что прежний исполнитель панели клал
 * своему процессу сам. Набор Qwen («Наши» на локальной модели) — свой `QWEN_HOME`, набор Codex
 * («оба набора») — правила текстом после брифа ядра (`developerInstructions` переходника).
 * Локальный ли прогон — по маршруту задачи: шлюз локального контура в разрешённом наборе.
 */

export interface KitExtras {
  args: string[];
  env: Record<string, string>;
  append?: string;
}

export interface ForeignCarryDeps {
  /** Строка о тестах проекта для каталога; `undefined` — каталог не проект. */
  testsNote(cwd: string): string | undefined;
  kitExtras(input: { provider: string; local: boolean; hasSources: boolean }): KitExtras;
}

export type ForeignCarryResolver = (
  input: Pick<CoreForeignStart, 'cli' | 'cwd' | 'routes'>,
) => CarryOutcome;

export function createForeignCarry(deps: ForeignCarryDeps): ForeignCarryResolver {
  return (input) => {
    const local = (input.routes ?? []).some(
      (r) => r.route.id === coreGatewayRouteId(LOCAL_PLATFORM_ID),
    );
    let extras: KitExtras;
    try {
      extras = deps.kitExtras({ provider: input.cli, local, hasSources: false });
    } catch (error) {
      // Набор не собрался — разговор без него ушёл бы на чужой слой вопреки режиму: отказ.
      return {
        ok: false,
        reason: `the panel kit did not compose: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const append = [input.cwd ? (deps.testsNote(input.cwd) ?? '') : '', extras.append ?? '']
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    return buildCarry({ append, args: extras.args, env: carriedEnvOf(extras.env) });
  };
}
