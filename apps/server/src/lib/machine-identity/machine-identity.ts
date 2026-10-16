import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { panelHomeDir } from '../brand.mjs';

/**
 * Кто эта машина для телефона, спаренного с несколькими панелями.
 *
 * Имя — чтобы в списке компьютеров стояло «DESKTOP-7Q…» или «MacBook-Pro», а не
 * адрес; человек его переименует у себя. `AGENTDECK_MACHINE_NAME` подменяет имя
 * для одноразовых панелей съёмки справки: настоящее имя машины в кадр попадать
 * не должно.
 *
 * Номер — чтобы телефон узнал машину, даже если адрес сменился (другой порт,
 * Tailscale вместо локальной сети), и чтобы уведомление открылось на той панели,
 * с которой пришло. Случайный, лежит в `~/.agentdeck/` рядом с токеном и не
 * переезжает с переносом настроек: две машины с одним номером телефон склеил бы.
 */

const ID_FILE = 'machine-id';

export function machineName(): string {
  return process.env.AGENTDECK_MACHINE_NAME?.trim() || hostname();
}

/** Прочитанные номера: спрашивают на каждом уведомлении, диск — один раз. */
const cache = new Map<string, string>();

export function machineIdPath(): string {
  return join(panelHomeDir(), ID_FILE);
}

/** Номер машины, созданный при первом обращении. */
export function machineId(path: string = machineIdPath()): string {
  const known = cache.get(path);
  if (known) return known;
  const stored = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  const value = stored || randomUUID();
  if (!stored) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${value}\n`);
  }
  cache.set(path, value);
  return value;
}
