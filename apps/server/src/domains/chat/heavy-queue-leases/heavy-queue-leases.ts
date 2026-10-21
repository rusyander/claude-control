import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../../../lib/safe-io/safe-io.ts';

/**
 * Записать число мест очереди в её каталог (`config.json`, атомарно). Хук читает
 * файл на каждом опросе, так что новое число доходит и до уже идущих групп: из
 * окружения, снятого при запуске CLI, 19.10 идущие группы держали два места
 * после подъёма до четырёх и стояли по 10–15 минут. Сбой записи — хук возьмёт
 * число из окружения, как прежде.
 * @returns записалось ли
 */
export function writeHeavyQueueConfig(dir: string, slots: number): boolean {
  if (!Number.isInteger(slots) || slots < 1) return false;
  try {
    writeJsonFile(join(dir, 'config.json'), { slots }, { preserveForm: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Снять аренды очереди тяжёлых шагов, которые держит сессия. Зовётся, когда прогон
 * закончился любым путём — «Стоп» человека, лимит, перезапуск панели. Хук отдаёт
 * аренду сам только в `PostToolUse`, а убитый CLI его уже не позовёт: аренда
 * доживала свой срок (до получаса) и держала место для всех остальных групп
 * (журнал 19.10 20:01 — остановленная группа заняла одно из двух мест).
 * Формат файла аренды — `tools/heavy-queue-hook.mjs`. Сбой чтения — ничего не снято.
 * @returns сколько аренд снято
 */
export function releaseSessionLeases(dir: string, sessionId: string): number {
  if (!sessionId) return 0;
  const root = join(dir, 'leases');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let released = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const lease = JSON.parse(readFileSync(join(root, name), 'utf8')) as { session?: unknown };
      if (lease.session !== sessionId) continue;
      rmSync(join(root, name), { force: true });
      released++;
    } catch {
      // Битую аренду уберёт сам хук по сроку.
    }
  }
  return released;
}

/**
 * Держит ли сессия аренду очереди тяжёлых шагов — идёт долгая проверка, и
 * молчание звена законно (сторож групп, R1). Аренда с истёкшим `until` — не
 * держит: её оставил убитый CLI, и хук уберёт её на следующем опросе, а до того
 * она глушила бы R1 до получаса. Только чтение; сбой — «не держит».
 */
export function sessionHoldsLease(dir: string, sessionId: string, now = Date.now()): boolean {
  if (!sessionId) return false;
  const root = join(dir, 'leases');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.endsWith('.json')) return false;
    try {
      const lease = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
        session?: unknown;
        until?: unknown;
      };
      return lease.session === sessionId && typeof lease.until === 'number' && lease.until > now;
    } catch {
      return false;
    }
  });
}
