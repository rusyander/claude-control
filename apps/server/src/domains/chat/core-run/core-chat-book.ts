import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoreChatBook, CoreChatEntry } from './core-run.types.ts';

/**
 * Книга разговоров чата на ядре (этап 10, F2, проход 3): id разговора CLI → задача ядра и её шаг
 * `chat`. Лежит файлом в данных панели: после перезапуска панели ход человека идёт сообщением
 * живому шагу (`message-to-step`), а не новой задачей с продолжением транскрипта.
 *
 * Запись, которой ядро уже не знает (задача кончилась, шаг закрыт), не вредит: прогон сверяет её
 * с видом задачи и при расхождении заводит новую задачу с `resume`.
 *
 * CLI разговора (этап 11, W3-17a) переживает конец задачи: продолжение идёт тем CLI, которым
 * разговор начат, — разговор одного CLI другой продолжить не может, а активный провайдер панели
 * за это время мог смениться. Поэтому `forget` снимает задачу и шаг, а CLI оставляет.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Запись на диске: задача и шаг есть, пока разговор живёт в ядре; CLI — всегда, если известен.
 * `tasks` — все задачи ядра, которые вели разговор, по порядку, и `cwd` — папка разговора (этап
 * 11, волна 3): у не-Claude CLI транскрипта панель не читает, его история — виды сеансов ЭТИХ задач
 * у ядра (`core-chat-history.ts`), а список чатов ставит разговор в его проект. Это указатели, не
 * копия разговора: текст ходов живёт только у ядра.
 */
interface StoredEntry {
  taskId?: string;
  stepId?: string;
  cli?: string;
  tasks?: string[];
  cwd?: string;
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Задачи записи: только годные id, без повторов; прежняя запись без списка — её живая задача. */
function tasksOf(e: Record<string, unknown>, taskId: string | undefined): string[] {
  const listed = Array.isArray(e.tasks)
    ? e.tasks.filter((t): t is string => typeof t === 'string' && SAFE_ID.test(t))
    : [];
  const all = taskId && !listed.includes(taskId) ? [...listed, taskId] : listed;
  return [...new Set(all)];
}

function readAll(file: string): Record<string, StoredEntry> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StoredEntry> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SAFE_ID.test(id) || !v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      const taskId = text(e.taskId);
      const stepId = text(e.stepId);
      const cli = text(e.cli);
      const cwd = text(e.cwd);
      const live = taskId && stepId ? { taskId, stepId } : {};
      const tasks = tasksOf(e, live.taskId);
      if (live.taskId || cli) {
        out[id] = {
          ...live,
          ...(cli ? { cli } : {}),
          ...(tasks.length > 0 ? { tasks } : {}),
          ...(cwd ? { cwd } : {}),
        };
      }
    }
    return out;
  } catch {
    // Битый файл — книга пуста: худшее — новая задача с продолжением разговора, а не сбой хода.
    return {};
  }
}

/** Файл книги в данных панели — тот же, что открывает проводка чата (`chat-wiring.ts`). */
export const coreChatBookPath = (appData: string): string => join(appData, 'core-chat-book.json');

/**
 * Знает ли книга разговор — чтением файла заново, мимо экземпляра проводки: тот держит записи в
 * памяти, а маршрут отправки спрашивает и о разговоре, начатом другим процессом панели.
 */
export function coreChatBookKnows(file: string, id: string): boolean {
  return SAFE_ID.test(id) && id in readAll(file);
}

/**
 * Разговор, который ведёт задача ядра, — по id задачи, чтением файла заново. Нужен переходу по
 * старой ссылке `/core/chat?id=<задача>` (W3-17a): страница свёрнута в `/chat`, и ссылка открывает
 * тот же разговор там. Задача, которой книга не помнит, — `undefined`, переход ведёт в пустой чат.
 */
export function coreChatOfTask(file: string, taskId: string): string | undefined {
  if (!SAFE_ID.test(taskId)) return undefined;
  const hit = Object.entries(readAll(file)).find(([, entry]) => entry.taskId === taskId);
  return hit?.[0];
}

/**
 * CLI начатого разговора — тот, которым его продолжит ход (`core-run.ts`: `cliOf ?? 'claude'`),
 * чтением файла заново. Шапка чата спрашивает каталог моделей ЭТОГО CLI (W3-17a): разговор Codex
 * при активном Claude не предлагает моделей Claude. Записи без CLI и разговоры, которых книга не
 * знает (прежние транскрипты), — Claude.
 */
export function coreChatCliOf(file: string, id: string): string {
  if (!SAFE_ID.test(id)) return 'claude';
  return readAll(file)[id]?.cli ?? 'claude';
}

export function createCoreChatBook(file: string): CoreChatBook {
  let entries = readAll(file);
  const save = (): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tmp, file);
  };
  return {
    get(id) {
      const e = entries[id];
      return e?.taskId && e.stepId ? { taskId: e.taskId, stepId: e.stepId } : undefined;
    },
    cliOf: (id) => entries[id]?.cli,
    set(id, entry: CoreChatEntry) {
      if (!SAFE_ID.test(id)) return;
      const prior = entries[id];
      const cli = entry.cli ?? prior?.cli;
      const cwd = entry.cwd ?? prior?.cwd;
      const known = prior?.tasks ?? [];
      const tasks = known.includes(entry.taskId) ? known : [...known, entry.taskId];
      entries = {
        ...entries,
        [id]: {
          taskId: entry.taskId,
          stepId: entry.stepId,
          ...(cli ? { cli } : {}),
          tasks,
          ...(cwd ? { cwd } : {}),
        },
      };
      save();
    },
    forget(id) {
      const e = entries[id];
      if (!e?.taskId) return;
      const { [id]: _gone, ...rest } = entries;
      // Задачи и папка остаются с CLI: история разговора не-Claude CLI — виды их сеансов у ядра.
      const kept = { ...(e.tasks ? { tasks: e.tasks } : {}), ...(e.cwd ? { cwd: e.cwd } : {}) };
      entries = e.cli ? { ...rest, [id]: { cli: e.cli, ...kept } } : rest;
      save();
    },
  };
}

/** Разговор не-Claude CLI в книге: его CLI, задачи ядра по порядку и папка. */
export interface CoreChatHistoryEntry {
  id: string;
  cli: string;
  tasks: string[];
  cwd?: string;
}

const historyOf = (id: string, e: StoredEntry | undefined): CoreChatHistoryEntry | undefined =>
  e?.cli && e.cli !== 'claude' && e.tasks && e.tasks.length > 0
    ? { id, cli: e.cli, tasks: e.tasks, ...(e.cwd ? { cwd: e.cwd } : {}) }
    : undefined;

/**
 * Разговоры, чья история — у ядра (этап 11, волна 3): CLI не Claude и хоть одна задача, чтением
 * файла заново. Разговор Claude читается из своего транскрипта, как прежде, — здесь его нет.
 */
export function coreChatHistoryEntries(file: string): CoreChatHistoryEntry[] {
  return Object.entries(readAll(file)).flatMap(([id, e]) => {
    const one = historyOf(id, e);
    return one ? [one] : [];
  });
}

/** Один разговор с историей у ядра; Claude, незнакомый или негодный id — `undefined`. */
export function coreChatHistoryEntry(file: string, id: string): CoreChatHistoryEntry | undefined {
  return SAFE_ID.test(id) ? historyOf(id, readAll(file)[id]) : undefined;
}
