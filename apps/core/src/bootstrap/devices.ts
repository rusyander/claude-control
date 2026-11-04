import { join } from 'node:path';
import { newId } from '../lib/ids/uuidv7.ts';
import { sha256Hex } from '../platform/core-config/files.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { createExclusive, readBytesSync } from '../platform/safe-io/files.ts';
import type { SigningDevice } from '../policy/authority/device-signature.ts';

/**
 * Устройства, чья подпись доказывает человека ядру (06 §Authority (b)), и номер машины в
 * подписанном сообщении. Привязка телефона к ядру — фаза 9 (G9); до неё список читается из
 * `<core home>/devices.json` (форма `phone-signing`: `{devices:[{id, publicKey, revokedAt?}]}`),
 * а его нет — подписей нет, и команды доказываются числом страницы. Правка списка мимо ядра при
 * записанной памяти — ни одного устройства (`devicesTampered`).
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

/** Отпечатки дрейфа списка, уже названные заметкой (на дом ядра, за жизнь процесса). */
const toldDrift = new Map<string, Set<string>>();

export type DevicesNote = (event: string, data: Record<string, unknown>) => void;

/**
 * Страж списка устройств (G9, как `config.json` — G6): `devices.state.json {digest}` пишет
 * команда привязки (фаза 9) вместе со списком. Память есть, а отпечаток `devices.json` другой —
 * список правлен мимо ядра: ни одно устройство не доказывает человека (подпись отказана), заметка
 * `devices.drift` один раз на отпечаток. Память не читается — тоже ни одного. Памяти нет —
 * поведение до фазы 9: список как есть.
 */
function devicesTampered(
  layout: CoreHomeLayout,
  bytes: Buffer,
  note: DevicesNote | undefined,
): boolean {
  const state = readBytesSync(join(layout.root, 'devices.state.json'));
  if ('absent' in state) return false;
  let digest: unknown;
  if ('value' in state) {
    try {
      digest = (JSON.parse(state.value.toString('utf8')) as { digest?: unknown } | null)?.digest;
    } catch {
      digest = undefined;
    }
  }
  const fileDigest = sha256Hex(bytes);
  if (typeof digest === 'string' && digest === fileDigest) return false;
  const told = toldDrift.get(layout.root) ?? new Set<string>();
  toldDrift.set(layout.root, told);
  if (!told.has(fileDigest)) {
    told.add(fileDigest);
    note?.('devices.drift', {
      fileDigest,
      reason:
        typeof digest === 'string'
          ? 'devices.json edited outside the core'
          : 'devices.state.json unreadable',
    });
  }
  return true;
}

export function loadSigningDevices(layout: CoreHomeLayout, note?: DevicesNote): SigningDevice[] {
  const read = readBytesSync(join(layout.root, 'devices.json'));
  if (!('value' in read)) return [];
  if (devicesTampered(layout, read.value, note)) return [];
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

/**
 * Перенос привязанных ключей телефона в устройства ядра (G9, команда `adopt-devices`, F11):
 * список заменяется целиком — отзыв в панели доезжает до ядра тем же переносом. Номер машины
 * панели (этап 10, Q5) становится номером ядра: телефон подписывает номером панели, и прежде ядро
 * отказывало каждой его подписи. Порядок: номер, `devices.json`, память
 * `devices.state.json {digest}`; крах между записями оставляет дрейф или старый номер — ни одной
 * принятой подписи, а не список без стража. Панель повторит перенос.
 */
export function adoptSigningDevices(
  layout: CoreHomeLayout,
  devices: readonly SigningDevice[],
  machineId: string,
): { digest: string } {
  const text = `${JSON.stringify({ devices }, null, 2)}\n`;
  const digest = sha256Hex(Buffer.from(text, 'utf8'));
  writeFileAtomic(join(layout.root, 'machine-id'), `${machineId}\n`, { mode: 0o600 });
  writeFileAtomic(join(layout.root, 'devices.json'), text, { mode: 0o600 });
  writeFileAtomic(join(layout.root, 'devices.state.json'), `${JSON.stringify({ digest })}\n`, {
    mode: 0o600,
  });
  // Память дрейфа процесса — о прежнем файле: новый отпечаток назовётся заново, если его правят.
  toldDrift.delete(layout.root);
  return { digest };
}

/** Порт ручки `/v1/devices/adopt`: запись списка + строки журнала ядра. */
export function devicesPortOf(
  layout: CoreHomeLayout,
  note: DevicesNote,
): {
  adopt(
    devices: readonly SigningDevice[],
    meta: { cmdId: string; by: string; machineId: string },
  ): { digest: string };
  refused(cmdId: string, code: string): void;
} {
  return {
    adopt(devices, meta) {
      const written = adoptSigningDevices(layout, devices, meta.machineId);
      note('devices.adopted', { ...meta, ids: devices.map((d) => d.id), digest: written.digest });
      return written;
    },
    refused: (cmdId, code) => note('devices.refused', { cmdId, code }),
  };
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
