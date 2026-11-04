import { readFileSync } from 'node:fs';
import {
  RELAY_DELIVERED_MAX,
  RELAY_PENDING_MAX,
  relayStateSchema,
  type RelayState,
} from '@agentdeck/contracts/core/relay';
import { writeJsonFile } from '../../lib/safe-io/safe-io.ts';

/** Имя файла пересылки в доме панели (`~/.agentdeck/core-relay.json`). */
export const RELAY_STATE_FILE = 'core-relay.json';

const empty = (): RelayState => ({ cursors: {}, delivered: [], pending: [] });

/**
 * Состояние пересылки. Файла нет — с нуля; файл не по схеме — тоже с нуля, но названо: тогда
 * поток перечитается с начала, и от второго сообщения о том же вопросе спасает только вид
 * задачи (отвеченный вопрос не открыт).
 */
export function readRelayState(path: string, log: (line: string) => void): RelayState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return empty();
  }
  try {
    const parsed = relayStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // разбор ниже назовёт файл
  }
  log(`core-relay: ${path} is not a relay state, starting over`);
  return empty();
}

/** Запись целиком (через временный файл): упавшая панель оставит прежнее, не половину. */
export function writeRelayState(path: string, state: RelayState): void {
  writeJsonFile(path, {
    cursors: state.cursors,
    delivered: state.delivered.slice(-RELAY_DELIVERED_MAX),
    pending: state.pending.slice(-RELAY_PENDING_MAX),
  });
}
