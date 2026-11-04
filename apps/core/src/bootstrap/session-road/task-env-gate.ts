import type { CliAdapter } from '../../adapters/adapter.types.ts';
import type { AdapterRegistry } from '../../adapters/index.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Окружение задачи на дороге сеанса (этап 10, F6). Имена — `task.created.session.env`, значения
 * уже в пине (`stepStart` берёт их из книги в памяти и снимает одноимённые переменные ядра).
 *
 * Два отказа до аренды и процесса:
 * - значения нет — ядро перезапускалось, книга пуста: сеанс на окружении ядра вместо окружения
 *   вызывающего (настоящий каталог конфигурации человека вместо песочницы) хуже отказа;
 * - переменная меняет дом конфигурации ДРУГОГО CLI, а этот её не читает: задача просила свой
 *   каталог конфигурации, а CLI сеанса пошёл бы со своим настоящим. Кто чей дом читает — факт
 *   переходника (`readLayer` от пина, без IO), а не список имён здесь.
 */

export function taskEnvNames(start: Pick<RoadStart, 'task'>): readonly string[] {
  return start.task.state.created?.session?.env ?? [];
}

const layerKey = (adapter: CliAdapter, pin: Record<string, string>): string =>
  JSON.stringify(adapter.readLayer(pin));

function without(pin: Record<string, string>, name: string): Record<string, string> {
  const out = { ...pin };
  delete out[name];
  return out;
}

/**
 * Значения окружения задачи для маски `known` (P61): всё, кроме дома конфигурации самого CLI
 * сеанса, — это путь, который человек видит в каждом ответе песочницы, а не секрет; секреты
 * стенда и прочие значения маскируются, в журнал идут только имена.
 */
export function taskEnvSecrets(
  start: Pick<RoadStart, 'task' | 'pin'>,
  adapter: CliAdapter,
): [string, string][] {
  const out: [string, string][] = [];
  for (const name of taskEnvNames(start)) {
    const value = start.pin[name];
    if (value === undefined) continue;
    if (layerKey(adapter, start.pin) !== layerKey(adapter, without(start.pin, name))) continue;
    out.push([name, value]);
  }
  return out;
}

export function taskEnvRefusal(
  start: Pick<RoadStart, 'task' | 'pin' | 'adapterId'>,
  adapter: CliAdapter,
  adapters: Pick<AdapterRegistry, 'all'>,
): string | null {
  const names = taskEnvNames(start);
  if (names.length === 0) return null;
  const missing = names.filter((n) => start.pin[n] === undefined);
  if (missing.length > 0) {
    return (
      `task-env-missing: no value for ${missing.join(', ')} — the values live only in core ` +
      'memory and are lost on a core restart; start the task again'
    );
  }
  for (const name of names) {
    const base = without(start.pin, name);
    if (layerKey(adapter, start.pin) !== layerKey(adapter, base)) continue;
    const owner = adapters
      .all()
      .find((a) => a.id !== adapter.id && layerKey(a, start.pin) !== layerKey(a, base));
    if (owner) {
      return (
        `task-env-unhonoured: the task pins ${name} (the config home of ${owner.id}); ` +
        `adapter ${start.adapterId} does not read it and would run on its own config`
      );
    }
  }
  return null;
}
