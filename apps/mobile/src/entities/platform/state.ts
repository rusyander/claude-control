import type { PlatformStatus } from '@agentdeck/contracts';
import type { PlatformProblem } from './state.types';

/**
 * Порядок ответов — от худшего к лучшему: сначала то, из-за чего работа встала.
 *
 * Отказ по бюджету идёт ПЕРВЫМ и обгоняет даже «выключен»: 402 значит, что
 * контур уже отказал живому запросу, и это единственное состояние, которое
 * человек не создавал сам и о котором иначе не узнает.
 *
 * Контур без пробы — НЕ «работает». Панель ни разу к нему не ходила (ни одной
 * пробы по кнопке, свежая настройка, разворот архива), и зелёная строка на
 * телефоне обещала бы живой контур на основании пустого места. Телефон не
 * пробует сам: он только на чтение.
 */
export function platformProblem(status: PlatformStatus): PlatformProblem {
  if (status.budget.exhausted) return 'exhausted';
  if (!status.platform.enabled) return 'off';
  if (!status.hasToken) return 'noKey';
  if (!status.health) return 'unchecked';
  if (status.health.outcome !== 'ok') return 'failed';
  return 'ok';
}
