import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MemberAdvice, StoredProjectChoice } from '@agentdeck/contracts/group-sources';
import { readJsonFile, writeJsonFile } from '../safe-io/safe-io.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Состояние групп по областям — отдельным файлом `group-sources.json` в каталоге
 * данных панели, а не срезом `state.json`.
 *
 * Причина практическая: `state.json` переносится снимком (`importStateSchema`
 * обязан назвать каждый ключ, иначе молча срежет), а здесь лежит то, что
 * описывает ЭТУ машину — какие файлы панель положила в какой проект и что там
 * было до неё. Перенос на другую машину таких записей не должен: там в
 * проектах лежит своё, и «вернуть как было» по чужой записи значило бы
 * испортить чужие файлы.
 */

const FILE = 'group-sources.json';
const VERSION = 1;

/** Что панель положила в проект, включив переопределение, и как это снять байт в байт. */
export interface OverrideRecord {
  groupId: string;
  /** Корень проекта — как его прислал клиент (для показа). */
  projectPath: string;
  file: string;
  /**
   * Блок панели в файле правила, как записан. Граница блока — строка конца; у
   * файла, записанного до неё, — эти байты. Ниже блока — правка человека (F-256).
   */
  ruleBlock?: string;
  /** Каталоги, которых до панели не было (`.claude`, `.claude/rules`) — снимаются, если пусты. */
  createdDirs: string[];
  /** Строки, дописанные в `.git/info/exclude`; `original` — файл до записи, `null` — его не было. */
  exclude?: { file: string; original: string | null; written: string; createdDirs: string[] };
  /** Запреты `Skill(<id>)` в `settings.local.json`; `original` — байты до записи. */
  deny?: { file: string; entries: string[]; original: string | null; written: string };
  writtenAt: string;
}

/** Советы по участникам ждут выбора человека: `copy` — после копирования, `merge` — слияние с оригиналом. */
export interface PendingAdvice {
  mode: 'copy' | 'merge';
  items: MemberAdvice[];
  /** У слияния — хэши оригинала, которые станут новой точкой отсчёта после применения. */
  theirs?: Record<string, { hash: string; text: string; from: string }>;
  at: string;
}

/** Участник оригинала на момент копирования. */
export interface MemberBase {
  /** Ключ участника в копии (`<kind>:<id>`): имя могло смениться суффиксом. */
  to: string;
  text: string;
  /** Участник копии — общий ресурс, живший до неё: советы его не удаляют. */
  reused?: true;
}

export interface GroupSourcesState {
  version: number;
  /**
   * Нормализованный путь проекта → выбор каждой его пары (id проектной группы →
   * ключ стороны). Строка — запись v1, один слот на проект: читается как выбор
   * названной пары (`pairChoiceOf`) и становится картой при следующей записи.
   */
  choices: Record<string, StoredProjectChoice>;
  /** Нормализованный путь проекта → запись переопределения. */
  overrides: Record<string, OverrideRecord>;
  /** id глобальной группы → советы, ждущие применения. */
  advice: Record<string, PendingAdvice>;
  /**
   * id глобальной копии → участники оригинала (`<kind>:<id>`) при копировании: их
   * текст тогда (основа трёхстороннего слияния) и ключ участника копии.
   */
  bases: Record<string, Record<string, MemberBase>>;
  /** Ключ находки обнаружения → id проектной группы, заведённой из неё. */
  imported: Record<string, string>;
}

function empty(): GroupSourcesState {
  return { version: VERSION, choices: {}, overrides: {}, advice: {}, bases: {}, imported: {} };
}

/** Прочитать файл данных панели, пережив его отсутствие и порчу: это кэш и записи, не конфиг. */
export function readPanelJson<T>(appData: string, name: string, fallback: T): T {
  try {
    return readJsonFile<T>(join(appData, name), fallback);
  } catch {
    return fallback;
  }
}

/** Записать файл данных панели атомарно, без копий: это собственные данные панели. */
export function writePanelJson(appData: string, name: string, value: unknown): void {
  if (!existsSync(appData)) mkdirSync(appData, { recursive: true });
  writeJsonFile(join(appData, name), value);
}

export function readGroupSources(appData: string): GroupSourcesState {
  const raw = readPanelJson<Partial<GroupSourcesState>>(appData, FILE, {});
  const base = empty();
  return {
    version: VERSION,
    choices: { ...base.choices, ...(isRecord(raw.choices) ? raw.choices : {}) },
    overrides: { ...base.overrides, ...(isRecord(raw.overrides) ? raw.overrides : {}) },
    advice: { ...base.advice, ...(isRecord(raw.advice) ? raw.advice : {}) },
    bases: { ...base.bases, ...(isRecord(raw.bases) ? raw.bases : {}) },
    imported: { ...base.imported, ...(isRecord(raw.imported) ? raw.imported : {}) },
  } as GroupSourcesState;
}

export function writeGroupSources(appData: string, state: GroupSourcesState): void {
  writePanelJson(appData, FILE, state);
}

/** Изменить состояние одной транзакцией чтения-записи. */
export function updateGroupSources<T>(appData: string, change: (state: GroupSourcesState) => T): T {
  const state = readGroupSources(appData);
  const result = change(state);
  writeGroupSources(appData, state);
  return result;
}

/** Ключ проекта: регистр и слэши не различаются, как у реестра проектов. */
export function projectKey(path: string): string {
  return normalizeProjectPath(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
