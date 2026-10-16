import type { MachineIdentity } from '@agentdeck/contracts';

/**
 * Список компьютеров, с которыми спарен телефон. Чистые функции без хранилища:
 * правила «тот же компьютер или новый» здесь, а куда класть — в `connection.ts`.
 *
 * Компьютер узнаём по номеру машины (`machineId` из `/api/system`), а пока номера
 * нет — по адресу. Номер важнее адреса: та же машина приходит то по локальной
 * сети, то через Tailscale, и два пункта на одну машину путали бы, куда уходит
 * работа. Токен в записи не лежит — у каждого свой ключ в защищённом хранилище.
 */

export interface PanelEntry {
  id: string;
  /** Базовый адрес API, без хвостового слэша. */
  url: string;
  /** Имя, данное человеком; пусто — подписываем именем машины. */
  name: string;
  /** Имя, которое назвала сама машина. */
  machineName: string;
  machineId: string;
  platform: string;
}

/** Подпись в списке: своё имя, иначе имя машины, иначе адрес без схемы. */
export function panelTitle(entry: PanelEntry): string {
  return entry.name || entry.machineName || entry.url.replace(/^https?:\/\//i, '');
}

/** Ключи SecureStore допускают только буквы, цифры и `._-` — id из того же набора. */
export function newPanelId(random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `p${Date.now().toString(36)}${tail}`;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Чтение сохранённого списка: битая запись не должна оставлять телефон без панелей. */
export function parsePanels(raw: string | null): PanelEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return parsed.flatMap((item: Record<string, unknown>) => {
    const id = text(item?.id);
    const url = text(item?.url);
    if (!SAFE_ID.test(id) || !url) return [];
    return [
      {
        id,
        url,
        name: text(item.name),
        machineName: text(item.machineName),
        machineId: text(item.machineId),
        platform: text(item.platform),
      },
    ];
  });
}

/** Спаривание: тот же адрес — та же запись (токен обновится), новый — новая запись. */
export function upsertByUrl(
  list: PanelEntry[],
  url: string,
  makeId: () => string = newPanelId,
): { list: PanelEntry[]; id: string } {
  const known = list.find((entry) => entry.url === url);
  if (known) return { list, id: known.id };
  const id = makeId();
  return {
    list: [...list, { id, url, name: '', machineName: '', machineId: '', platform: '' }],
    id,
  };
}

/**
 * Машина назвалась. Если этот номер уже есть под другой записью — это тот же
 * компьютер по новому адресу: остаётся старая запись (с именем, которое дал
 * человек) и получает новый адрес, а свежая исчезает. `dropped` — id исчезнувшей:
 * её токен вызывающий переносит в оставшуюся.
 */
export function applyIdentity(
  list: PanelEntry[],
  id: string,
  identity: MachineIdentity,
): { list: PanelEntry[]; id: string; dropped?: string } {
  const self = list.find((entry) => entry.id === id);
  if (!self) return { list, id };
  const twin = identity.machineId
    ? list.find((entry) => entry.id !== id && entry.machineId === identity.machineId)
    : undefined;
  const described = {
    machineName: identity.machineName,
    machineId: identity.machineId,
    platform: identity.platform,
  };
  if (!twin) {
    return {
      list: list.map((entry) => (entry.id === id ? { ...entry, ...described } : entry)),
      id,
    };
  }
  return {
    list: list
      .filter((entry) => entry.id !== id)
      .map((entry) => (entry.id === twin.id ? { ...entry, ...described, url: self.url } : entry)),
    id: twin.id,
    dropped: id,
  };
}

export function renameEntry(list: PanelEntry[], id: string, name: string): PanelEntry[] {
  return list.map((entry) => (entry.id === id ? { ...entry, name: name.trim() } : entry));
}

/** Убрали компьютер: если он был выбран, выбранным становится первый оставшийся. */
export function removeEntry(
  list: PanelEntry[],
  id: string,
  activeId: string,
): { list: PanelEntry[]; activeId: string } {
  const rest = list.filter((entry) => entry.id !== id);
  return { list: rest, activeId: activeId === id ? (rest[0]?.id ?? '') : activeId };
}
