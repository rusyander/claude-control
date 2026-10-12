import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_INPUT_KEEP, type RunInputRecord } from '@agentdeck/contracts/run-input';
import { writeJsonFile } from '../../../lib/safe-io/safe-io.ts';

/**
 * Хранилище «что получил агент» (U8): файл на разговор в каталоге данных
 * панели, последние `RUN_INPUT_KEEP` прогонов, текст — целиком.
 *
 * Свой каталог, а не `state.json` и не транскрипт: вход прогона бывает в сотни
 * килобайт, и мешать его с настройками значило бы гонять их на диск ради
 * каждого хода; транскрипт же пишет CLI, и дописка к системному промпту туда
 * не попадает вовсе. Битый файл — пустой список, а не сбой прогона.
 *
 * Ключ — тот же, под которым разговор знает связь конвейера: `sessionId` у
 * Claude, `<провайдер>:<id>` у чужого CLI. Имя файла — ключ в
 * `encodeURIComponent`: двоеточие на Windows в имени файла запрещено.
 */

function dirOf(appDataDir: string): string {
  return join(appDataDir, 'run-inputs');
}

function fileOf(appDataDir: string, key: string): string {
  return join(dirOf(appDataDir), `${encodeURIComponent(key)}.json`);
}

function isRecord(value: unknown): value is RunInputRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<RunInputRecord>;
  return typeof record.startedAt === 'number' && typeof record.prompt === 'string';
}

/** Записи разговора, старые первыми — в порядке записи. */
function readStored(appDataDir: string, key: string): RunInputRecord[] {
  const path = fileOf(appDataDir, key);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

/** Входы прогонов разговора, свежие первыми — их и читают сверху вниз. */
export function readRunInputs(appDataDir: string, key: string): RunInputRecord[] {
  return readStored(appDataDir, key).reverse();
}

/**
 * Дописать вход прогона; старше предела — уходят самые давние ПРОГОНЫ, текст не
 * режется. Вход того же прогона (тот же `startedAt`) заменяет прежний: путь
 * чужого CLI, уступивший следующему, сообщает вход ещё раз (TQ-09).
 */
export function appendRunInput(appDataDir: string, key: string, record: RunInputRecord): void {
  mkdirSync(dirOf(appDataDir), { recursive: true });
  const stored = readStored(appDataDir, key);
  const kept = stored.at(-1)?.startedAt === record.startedAt ? stored.slice(0, -1) : stored;
  const next = [...kept, record].slice(-RUN_INPUT_KEEP);
  writeJsonFile(fileOf(appDataDir, key), next);
}

/**
 * Временный ключ нового разговора сменился настоящим `sessionId`: записи едут
 * за ним, иначе первый ход — как раз задание звена — пропал бы из сверки.
 * У настоящего ключа записи уже есть (продолжение) — сливаем по времени.
 */
export function moveRunInputs(appDataDir: string, from: string, to: string): void {
  if (from === to) return;
  const moved = readStored(appDataDir, from);
  if (moved.length === 0) return;
  const existing = readStored(appDataDir, to);
  if (existing.length === 0) {
    renameSync(fileOf(appDataDir, from), fileOf(appDataDir, to));
    return;
  }
  const merged = [...existing, ...moved]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-RUN_INPUT_KEEP);
  writeJsonFile(fileOf(appDataDir, to), merged);
  rmSync(fileOf(appDataDir, from), { force: true });
}
