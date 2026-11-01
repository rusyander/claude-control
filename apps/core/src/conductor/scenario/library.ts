import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  scenarioSchema,
  type Scenario,
  type ScenarioRef,
} from '@agentdeck/contracts/core/scenario';
import type { z } from 'zod';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import type { ReadClassName } from '../../lib/facts/read-classes.ts';
import { createExclusive, listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { isPresetId } from './presets.ts';

/**
 * Библиотека сценариев человека: `<дом ядра>/scenarios/<id>@<v>.json`, каждая версия пишется
 * один раз (G11). Перезаписи нет: задача, начатая на версии N, читает ровно её и после правки —
 * правка становится версией N+1. Чтение — через класс `scenario.library`: нечитаемый файл
 * не «нет сценария» (P44), а отказ запуска с причиной.
 */

const BOM = 0xfeff;
const FILE = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,8})\.json$/;

export function libraryFile(dir: string, ref: ScenarioRef): string {
  return join(dir, `${ref.id}@${ref.version}.json`);
}

/** Текст файла фактом заданного класса: «нет» — только прочитанное отсутствие. */
export function readTextAs(readClass: ReadClassName, path: string): Promise<Fact<string>> {
  return readFact(readClass, () => {
    const got = readBytesSync(path);
    if ('absent' in got) return absent();
    if ('unknown' in got) throw new Error(got.unknown);
    return got.value.toString('utf8');
  });
}

/** Проблемы схемы одной строкой на каждую — путь и сообщение, как у разбора команд. */
export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

export type ParsedScenario = { ok: true; scenario: Scenario } | { ok: false; reason: string };

export function parseScenarioText(text: string): ParsedScenario {
  let json: unknown;
  try {
    // Файл, сохранённый блокнотом Windows, начинается с BOM — это не порча.
    json = JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text);
  } catch (error) {
    return { ok: false, reason: `not JSON: ${(error as Error).message}` };
  }
  const parsed = scenarioSchema.safeParse(json);
  return parsed.success
    ? { ok: true, scenario: parsed.data }
    : { ok: false, reason: issuesOf(parsed.error).join('; ') };
}

export type LibraryRead =
  | { kind: 'value'; scenario: Scenario }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Одна версия из библиотеки; имя файла обязано совпасть с id и версией внутри. */
export async function readLibraryScenario(dir: string, ref: ScenarioRef): Promise<LibraryRead> {
  const text = await readTextAs('scenario.library', libraryFile(dir, ref));
  if ('absent' in text) return { kind: 'absent' };
  if ('unknown' in text) return { kind: 'unknown', reason: text.unknown };
  const parsed = parseScenarioText(text.value);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  const { id, version } = parsed.scenario;
  if (id !== ref.id || version !== ref.version)
    return { kind: 'invalid', reason: `file ${ref.id}@${ref.version} holds ${id}@${version}` };
  return { kind: 'value', scenario: parsed.scenario };
}

export interface LibraryListing {
  scenarios: Scenario[];
  /** Файлы, которые не прочлись или не по схеме, — названы, не пропущены молча. */
  problems: { file: string; reason: string }[];
}

/** Вся библиотека: нет каталога — пусто; каталог не читается — `unknown`. */
export async function listLibrary(
  dir: string,
): Promise<{ value: LibraryListing } | { unknown: string }> {
  const names = await readFact('scenario.library', () => {
    const got = listDir(dir);
    if ('absent' in got) return absent();
    if ('unknown' in got) throw new Error(got.unknown);
    return got.value;
  });
  if ('unknown' in names) return names;
  const listing: LibraryListing = { scenarios: [], problems: [] };
  if ('absent' in names) return { value: listing };
  for (const file of [...names.value].sort()) {
    const match = FILE.exec(file);
    if (!match) continue;
    const ref = { id: match[1] as string, version: Number(match[2]) };
    const read = await readLibraryScenario(dir, ref);
    if (read.kind === 'value') listing.scenarios.push(read.scenario);
    else if (read.kind !== 'absent')
      listing.problems.push({ file, reason: `${read.kind}: ${read.reason}` });
  }
  return { value: listing };
}

/** Последняя версия id в библиотеке; нет ни одной — 0. */
export function latestVersion(listing: LibraryListing, id: string): number {
  return listing.scenarios.reduce(
    (max, s) => (s.id === id && s.version > max ? s.version : max),
    0,
  );
}

export function scenarioText(scenario: Scenario): string {
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

export type LibraryWrite =
  | { written: 'created' | 'same' }
  | { refused: 'preset-id-reserved' | 'version-taken'; reason: string };

/**
 * Запись версии один раз. Тот же текст уже лежит — `same` (повтор после краха между записью
 * и строкой журнала); другой текст под той же версией — отказ, перезаписи нет.
 */
export async function writeLibraryScenario(dir: string, scenario: Scenario): Promise<LibraryWrite> {
  if (isPresetId(scenario.id))
    return {
      refused: 'preset-id-reserved',
      reason: `${scenario.id} is a built-in preset id; save the edit under a new id`,
    };
  const ref = { id: scenario.id, version: scenario.version };
  const text = scenarioText(scenario);
  if (createExclusive(libraryFile(dir, ref), text) === 'created') return { written: 'created' };
  const existing = await readTextAs('scenario.library', libraryFile(dir, ref));
  if ('value' in existing && existing.value === text) return { written: 'same' };
  return {
    refused: 'version-taken',
    reason: `${ref.id}@${ref.version} already holds another scenario; versions are write-once`,
  };
}
