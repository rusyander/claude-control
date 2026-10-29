import { join } from 'node:path';
import { newId } from '../lib/ids/uuidv7.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { createExclusive, readBytesSync } from '../platform/safe-io/files.ts';
import type { SigningDevice } from '../policy/authority/device-signature.ts';

/**
 * Устройства, чья подпись доказывает человека ядру (06 §Authority (b)), и номер машины в
 * подписанном сообщении. Привязка телефона к ядру — фаза 7; до неё список читается из
 * `<core home>/devices.json` (форма `phone-signing`: `{devices:[{id, publicKey, revokedAt?}]}`),
 * а его нет — подписей нет, и команды доказываются числом страницы.
 */

export function machineIdOf(layout: CoreHomeLayout): string {
  const path = join(layout.root, 'machine-id');
  createExclusive(path, `${newId()}\n`, 0o600);
  const read = readBytesSync(path);
  if (!('value' in read)) throw new Error(`machine-id unreadable: ${path}`);
  const id = read.value.toString('utf8').trim();
  if (id) return id;
  // Пустой файл — крах между созданием `wx` и записью (ревью m3): пустой номер машины в
  // подписанном сообщении совпал бы у любых двух таких машин. Им не подписано ничего — номер
  // выдаётся заново, атомарной заменой.
  const fresh = newId();
  writeFileAtomic(path, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

export function loadSigningDevices(layout: CoreHomeLayout): SigningDevice[] {
  const read = readBytesSync(join(layout.root, 'devices.json'));
  if (!('value' in read)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.toString('utf8'));
  } catch {
    // Испорченный список — ни одного годного устройства (подпись не пройдёт), а не «все».
    return [];
  }
  // `null` и не-объекты в файле или в списке — не устройство: раньше они роняли каждую команду
  // с подписью TypeError-ом, а не давали «ни одного устройства».
  if (typeof parsed !== 'object' || parsed === null) return [];
  const devices = (parsed as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  const byId = new Map<string, SigningDevice>();
  for (const item of devices as unknown[]) {
    const device = deviceOf(item);
    if (!device) continue;
    const seen = byId.get(device.id);
    if (!seen) {
      byId.set(device.id, device);
      continue;
    }
    // Дубль id (ревью F-108): раньше побеждала первая запись, и поздний отзыв не действовал.
    // Отзыв любой из записей отзывает id; два разных ключа под одним id — неоднозначно, отозван.
    const revokedAt =
      seen.revokedAt ??
      device.revokedAt ??
      (seen.publicKey === device.publicKey ? undefined : 'duplicate id with another key');
    byId.set(device.id, { ...seen, ...(revokedAt ? { revokedAt } : {}) });
  }
  return [...byId.values()];
}

function deviceOf(item: unknown): SigningDevice | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const d = item as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.publicKey !== 'string') return undefined;
  if (!('revokedAt' in d) || d.revokedAt === undefined) return { id: d.id, publicKey: d.publicKey };
  // Поле отзыва есть, но не непустая строка (0, null, false) — отозвано: форма поля не делает
  // отозванное устройство снова годным (ревью F-108).
  const revokedAt =
    typeof d.revokedAt === 'string' && d.revokedAt ? d.revokedAt : `malformed revokedAt`;
  return { id: d.id, publicKey: d.publicKey, revokedAt };
}
