import { usePlatformRunPlan } from '../api/PlatformApi';
import { turnToolHint, type TurnToolHint } from './turnToolHint';

/**
 * Подсказка хода по плану прогона ЭТОГО потребителя: контур мог вести чат и
 * не вести группы, и спрашивать надо тот же план, что называет модель в шапке.
 * Факты хода — у страницы: Claude считает вызовы по блокам ленты, чужой CLI —
 * по счёту шлюза в реплике.
 */
export function useTurnToolHint(
  consumer: string,
  facts: { toolCalls: number | undefined; text: string } | undefined,
  running: boolean,
): TurnToolHint | undefined {
  const plan = usePlatformRunPlan(facts ? consumer : '');
  if (!facts || !plan.data) return undefined;
  return turnToolHint({
    routed: plan.data.routed,
    running,
    ...(plan.data.toolRoute ? { toolRoute: plan.data.toolRoute } : {}),
    ...facts,
  });
}
