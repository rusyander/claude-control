import type { CliAdapter, SessionLayerCarry } from '../../adapters/adapter.types.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Перенос слоя панели на дороге сеанса (G6): плагины набора, сужение источников настроек, список
 * встроенных инструментов — типизированные поля `task.created.session`, а не сырые аргументы CLI.
 * Каждое поле несёт только переходник, объявивший его в `sessionCarry`; прочим — отказ по имени
 * поля до аренды и процесса: сеанс без набора правил, который человек включил, хуже отказа.
 *
 * Плагин несёт хуки — с выключенными хуками сеанса (`layer.hooks` не `on`) его хуки шли бы мимо
 * режима, который ядро назначило шагу; такой перенос отказан, а не урезан молча. Хуки профиля чата
 * панели (`carry.hooks`, s12) — тем же судом.
 */
export function sessionCarryRefusal(
  start: Pick<RoadStart, 'layer' | 'adapterId'>,
  adapter: Pick<CliAdapter, 'sessionCarry'>,
): string | null {
  const carry = start.layer.carry;
  if (!carry) return null;
  const given = (Object.keys(carry) as (keyof SessionLayerCarry)[]).filter(
    (k) => carry[k] !== undefined,
  );
  const unsupported = given.filter((k) => !adapter.sessionCarry?.[k]);
  if (unsupported.length > 0) {
    return (
      `session-carry-unsupported: adapter ${start.adapterId} cannot carry ` +
      `${unsupported.join(', ')} — start the chat in a CLI that does, or drop the field`
    );
  }
  if ((carry.plugins?.length ?? 0) > 0 && start.layer.hooks !== 'on') {
    return (
      `session-carry-plugins-without-hooks: plugins carry hooks, the step runs hooks ` +
      `'${start.layer.hooks}' — a plugin would bypass the step's hook mode`
    );
  }
  // Хуки профиля чата панели (s12) — тот же суд, что плагины: шаг без хуков их не исполняет.
  if (carry.hooks && Object.keys(carry.hooks).length > 0 && start.layer.hooks !== 'on') {
    return (
      `session-carry-plugins-without-hooks: panel profile hooks are hooks, the step runs hooks ` +
      `'${start.layer.hooks}' — they would bypass the step's hook mode`
    );
  }
  return null;
}
