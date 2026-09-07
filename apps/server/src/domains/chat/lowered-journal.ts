import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import { writeJsonFile } from '../../lib/safe-io.ts';

/**
 * Журнал понижённых прогонов веера: чем вели и видела ли панель проверки.
 *
 * Живёт СВОИМ файлом в каталоге данных панели, а не в `state.json`, по двум
 * причинам. Журнал дописывается на каждом завершении прогона, а `state.json` —
 * это настройки, группы и привязки: мешать редко меняющееся с потоком записей
 * значит гонять на диск килобайты настроек ради одной строки. И порча журнала
 * не должна утаскивать за собой настройки: битый файл здесь означает пустой
 * журнал, а не панель без групп.
 *
 * Смысл записи и честные границы `checks` — в самом типе (`LoweredRunRecord`).
 */

/** Сколько записей держим. Строка на прогон; больше нужно только аналитике. */
const LIMIT = 200;

export function journalPath(appDataDir: string): string {
  return join(appDataDir, 'lowered-runs.json');
}

/**
 * Команды, по которым видно, что агент прогнал проверки проекта. Список ведётся
 * руками: вывести его из проекта нельзя — панель не знает, чем в нём проверяют.
 *
 * Планка сдачи требует ровно три вещи — типы, линт, тесты, — поэтому сборки
 * здесь нет: `build` бывает и частью работы, и засчитывать его за проверку
 * значило бы считать сделанным то, чего не делали.
 */
const CHECK_PATTERNS: readonly RegExp[] = [
  // Прямые запуски инструментов.
  /\b(vitest|jest|pytest|mocha|phpunit|rspec|eslint|tsc|depcruise|mypy|ruff|flake8)\b/,
  // Через менеджер пакетов: `pnpm test`, `npm run lint`, `yarn type-check`.
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|lint|type-check|typecheck|check)\b/,
  // Родные проверки языков и сборщиков.
  /\b(go|cargo|dotnet|mvn|gradle|swift)\s+test\b/,
  /\bmake\s+(test|lint|check)\b/,
];

/**
 * Похожа ли команда на прогон проверок проекта.
 *
 * Ошибается в ОБЕ стороны и по-другому не может: «git commit -m "fix tests"»
 * сюда не попадёт (слово `test` не стоит командой), а вот свой скрипт-обёртка
 * над тестами — попадёт мимо. Поэтому и в журнале, и в интерфейсе речь идёт о
 * замеченном, а не о выполненном.
 */
export function looksLikeCheck(command: string): boolean {
  const text = command.toLowerCase();
  return CHECK_PATTERNS.some((pattern) => pattern.test(text));
}

/** Прочитать журнал. Битый или отсутствующий файл — пустой журнал, без крика. */
export function readLoweredRuns(appDataDir: string): LoweredRunRecord[] {
  const path = journalPath(appDataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

/** Дописать запись, обрезав журнал до предела. Свежие — в конце. */
export function appendLoweredRun(appDataDir: string, record: LoweredRunRecord): void {
  const next = [...readLoweredRuns(appDataDir), record].slice(-LIMIT);
  writeJsonFile(journalPath(appDataDir), next);
}

/**
 * Сводка для интерфейса: сколько понижённых прогонов и у скольких из них панель
 * НЕ ВИДЕЛА проверок. Считается здесь, а не на вебе: правило «что считать
 * проверкой» одно и живёт рядом со списком образцов.
 *
 * Упавший прогон не попадает НИ В ОДНУ из двух корзин про проверки: он до них не
 * дошёл, и записывать его в «сдал без проверок» значило бы обвинять агента в том,
 * чего он не мог сделать. Три числа не пересекаются и в сумме дают `total`.
 */
export function summarizeLoweredRuns(records: LoweredRunRecord[]): LoweredRunsSummary {
  return { ...countBucket(records), byKind: summarizeByKind(records) };
}

/** Три корзины проверок плюс расход окна — считаются одинаково для всех разрезов. */
function countBucket(records: LoweredRunRecord[]): LoweredRunsCount {
  const finished = records.filter((record) => record.ok);
  const withChecks = finished.filter((record) => record.checks.length > 0).length;
  return {
    total: records.length,
    withChecks,
    withoutChecks: finished.length - withChecks,
    failed: records.length - finished.length,
    tokens: records.reduce((sum, record) => sum + (record.tokens ?? 0), 0),
  };
}

/**
 * Разрез по КЛАССУ работы: во что обошёлся каждый класс и как часто по нему
 * доходило до проверок.
 *
 * Зачем это человеку, а не панели. Таблица «класс → модель» живёт в коде
 * (`contracts/model-cascade.ts`), и правит её человек — но до сих пор правил
 * вслепую: сколько окна съедает `implementation` против `mechanical`, не знал
 * никто. Здесь он это видит.
 *
 * Почему те же числа НЕ уезжают агенту-классификатору: узнав, что `mechanical`
 * дешевле всех, модель начнёт метить механикой всё подряд. Весь смысл подбора в
 * том, что агент называет РОД работы, а модель под него подставляет панель;
 * подсказка про цену классов превратила бы классификацию в выбор себе модели —
 * ровно то, от чего уходили.
 *
 * Классы упорядочены по расходу окна: сверху то, что съело больше всего.
 * Прогоны без класса (ручной веер) собираются в строку с пустым `kind` —
 * прятать их нельзя, они тоже расход.
 */
function summarizeByKind(records: LoweredRunRecord[]): LoweredRunsKind[] {
  const groups = new Map<string, LoweredRunRecord[]>();
  for (const record of records) {
    const key = record.kind ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  return [...groups.entries()]
    .map(([kind, group]) => ({ kind, ...countBucket(group) }))
    .sort((a, b) => b.tokens - a.tokens || b.total - a.total);
}

/** Сколько прогонов и во что они обошлись. */
export interface LoweredRunsCount {
  total: number;
  withChecks: number;
  withoutChecks: number;
  failed: number;
  /** Сумма окна по прогонам разреза; записи старше 08.09.2026 добавляют ноль. */
  tokens: number;
}

/** Строка разреза по классам; пустой `kind` — прогоны, которым класса не называли. */
export interface LoweredRunsKind extends LoweredRunsCount {
  kind: string;
}

export interface LoweredRunsSummary extends LoweredRunsCount {
  byKind: LoweredRunsKind[];
}

function isRecord(value: unknown): value is LoweredRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LoweredRunRecord>;
  return (
    typeof record.chatId === 'string' &&
    typeof record.model === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.finishedAt === 'number' &&
    Array.isArray(record.checks)
  );
}
