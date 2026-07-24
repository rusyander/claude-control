import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DiffLine, HistoryDiff, HistoryEntry } from '@claude-control/contracts';
import { writeTextFile } from '../lib/safe-io.ts';
import type { TrackedFile } from './tracked-files.ts';

/**
 * История изменений конфигурации — лента правок с построчным диффом.
 *
 * Копии складываются перед каждой записью (см. safe-io/backupEntry), значит это
 * снимки файлов во времени. По ним строится лента: копии группируются по
 * целевому файлу и сортируются по времени, а для каждой считается, ЧТО в ней
 * изменилось.
 *
 * Отслеживаемые файлы приходят списком `TrackedFile[]` (см. `tracked-files.ts`):
 * файлы Claude и файлы активного провайдера. Копии сопоставляются с целью по
 * ИМЕНИ КОПИИ (`backupBase`), а не по basename файла — у провайдеров копия
 * называется `<id>-<basename>`, иначе `gemini-settings.json` схлопнулся бы с
 * `settings.json` Claude. У файлов провайдера `canRevert:false` — дифф
 * показываем, поханочный откат не даём (нельзя записать чужой файл поверх
 * конфигурации Claude).
 *
 * Направление диффа — хронологически вперёд (старое → новое), чтобы «+N/−M»
 * читались как «столько добавили/убрали этой правкой»:
 *   • обычная копия ci сравнивается с ПРЕДЫДУЩЕЙ (более старой) копией c(i−1) —
 *     показывается правка, которая привела к ci;
 *   • самая свежая копия сравнивается с ТЕКУЩИМ файлом на диске — это последняя,
 *     ещё не забэкапленная правка;
 *   • у самой старой копии предыдущей нет — это первая известная версия, диффа
 *     против неё не строим.
 *
 * Дифф — свой минимальный LCS по строкам, без npm-зависимостей. Большие и
 * бинарные файлы не разбираем: держим ленту дешёвой и не тащим мусор в UI.
 */

/** Имя копии: `<файл>.<метка времени>.bak` — та же форма, что в safe-io/backups. */
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.bak$/;

/** Метка времени в имени: ISO с `:` и `.`, заменёнными на `-` (safe-io/backupEntry). */
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/**
 * Время копии берём из ИМЕНИ, а не из mtime: имя фиксирует момент снятия копии
 * и не сбивается при перезаписи файла (копирование обновило бы mtime). По нему
 * же строится хронологический порядок ленты. Не разобралось — падаем на mtime.
 */
function parseStamp(stamp: string, fallbackMs: number): string {
  const match = STAMP.exec(stamp);
  if (!match) return new Date(fallbackMs).toISOString();
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

/** Потолок построчного диффа: выше — «дифф не показывается». */
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 5000;

/** Один снимок файла: копия на диске плюс разобранное время. */
interface Snapshot {
  name: string;
  path: string;
  at: string;
}

/**
 * Копии одного целевого файла, отсортированные ПО ВОЗРАСТАНИЮ времени.
 * Ключ — `backupBase` цели (имя, под которым копия лежит на диске); в значении
 * только копии известных конфиг-файлов.
 */
function collectSnapshots(backupDir: string, targets: TrackedFile[]): Map<string, Snapshot[]> {
  const known = new Set(targets.map((target) => target.backupBase));
  const byFile = new Map<string, Snapshot[]>();

  if (!existsSync(backupDir)) return byFile;

  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;

    const target = match[1] ?? name;
    // Только известные файлы конфигурации: копия постороннего файла (или папка
    // скилла) в ленту не попадает — читать произвольные пути мы не даём.
    if (!known.has(target)) continue;

    const path = join(backupDir, name);
    const stats = statSync(path);
    // Папки (копии скиллов) сюда не входят: история — про файлы конфигурации.
    if (stats.isDirectory()) continue;

    const list = byFile.get(target) ?? [];
    list.push({ name, path, at: parseStamp(match[2] ?? '', stats.mtimeMs) });
    byFile.set(target, list);
  }

  for (const list of byFile.values()) {
    // По возрастанию: старое сравнивается с новым, свежее — с текущим файлом.
    list.sort((a, b) => a.at.localeCompare(b.at));
  }

  return byFile;
}

/** Метка «против чего дифф» — переносим её и в ленту, и в полный дифф. */
type BaseLabel = 'previous' | 'current' | 'initial';

/**
 * Что взять базой сравнения для копии по её индексу в отсортированном списке.
 * Возвращает путь к базе (undefined — базы нет) и метку.
 */
function resolveBase(
  snapshots: Snapshot[],
  index: number,
  currentPath: string,
): { basePath?: string; label: BaseLabel } {
  const isNewest = index === snapshots.length - 1;

  // Самая свежая копия сравнивается с текущим файлом на диске.
  if (isNewest) {
    return existsSync(currentPath)
      ? { basePath: currentPath, label: 'current' }
      : { label: 'initial' };
  }

  // Прочие — с предыдущей (более старой) копией.
  const previous = snapshots[index - 1];
  if (previous) return { basePath: previous.path, label: 'previous' };

  // Самая старая копия: предыдущей нет — первая известная версия.
  return { label: 'initial' };
}

/**
 * Направление диффа зависит от базы. Для «current» новее — текущий файл, а сам
 * снимок старше; для «previous» новее — сам снимок. Возвращаем пару (старое,
 * новое) для diffLines, чтобы «+/−» смотрели хронологически вперёд.
 */
function orderVersions(
  snapshotText: string,
  baseText: string,
  label: BaseLabel,
): { before: string; after: string } {
  return label === 'current'
    ? { before: snapshotText, after: baseText }
    : { before: baseText, after: snapshotText };
}

/** Похоже ли на бинарный файл — есть NUL-байт, которого в текстовых конфигах нет. */
function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

function tooBig(before: string, after: string): boolean {
  return (
    before.length > MAX_DIFF_BYTES ||
    after.length > MAX_DIFF_BYTES ||
    countLines(before) > MAX_DIFF_LINES ||
    countLines(after) > MAX_DIFF_LINES
  );
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

/**
 * Разбор текста на строки для сравнения. CRLF приводим к LF, чтобы разница в
 * концах строк не выглядела как правка всего файла; единственный завершающий
 * перевод строки отбрасываем — иначе у файла с финальным переводом появлялась
 * бы фантомная пустая строка.
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalized.split('\n');
}

/**
 * Построчный дифф двух версий текста через LCS. Наибольшая общая подпоследо-
 * вательность строк — это «неизменные» строки; всё, что в неё не вошло, слева
 * удалено, справа добавлено. Возвращает строки по порядку и счётчики +N/−M.
 *
 * Чистая функция без ввода-вывода: отдельно тестируется на собранных руками
 * строках. Сложность O(n·m) по числу строк — оправдана верхним пределом
 * MAX_DIFF_LINES у вызывающей стороны.
 */
export function diffLines(
  before: string,
  after: string,
): { lines: DiffLine[]; added: number; removed: number } {
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length;
  const m = b.length;

  // dp[i][j] — длина LCS суффиксов a[i..] и b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  // Обход по восстановленному пути LCS: совпало — контекст; иначе шаг туда, где
  // LCS не убывает, порождая удаление (слева) или добавление (справа).
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'del', text: a[i]! });
      removed += 1;
      i += 1;
    } else {
      lines.push({ kind: 'add', text: b[j]! });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: a[i]! });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j]! });
    added += 1;
    j += 1;
  }

  return { lines, added, removed };
}

function readText(path?: string): string {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/**
 * Пронумеровать ханки: непрерывный ряд строк add/del — один ханк, строка ctx
 * его разрывает. Индекс проставляется строкам правок (add/del), у контекста
 * остаётся не задан. Ровно эту же нумерацию воспроизводит `buildRevertedText`
 * и клиент — так номер ханка из запроса указывает на тот же блок, что видит
 * пользователь.
 */
function assignHunks(lines: DiffLine[]): void {
  let hunk = -1;
  let inHunk = false;
  for (const line of lines) {
    if (line.kind === 'ctx') {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      hunk += 1;
      inHunk = true;
    }
    line.hunk = hunk;
  }
}

/**
 * Пересобрать текущий файл, откатив ОДИН ханк к состоянию копии.
 *
 * Дифф ориентирован «копия → текущий файл»: строки add есть в текущем файле и
 * нет в копии, строки del — наоборот. Чтобы сохранить текущий файл, всюду берём
 * его сторону (add) и отбрасываем сторону копии (del). В выбранном ханке —
 * ровно обратное: берём копию (del), отбрасываем текущее (add). Остальные ханки
 * не трогаются вовсе.
 *
 * Возвращает undefined, если ханка с таким индексом в диффе нет.
 */
function buildRevertedText(
  lines: DiffLine[],
  hunkIndex: number,
  currentText: string,
): string | undefined {
  const out: string[] = [];
  let hunk = -1;
  let inHunk = false;
  let matched = false;

  for (const line of lines) {
    if (line.kind === 'ctx') {
      inHunk = false;
      out.push(line.text);
      continue;
    }
    if (!inHunk) {
      hunk += 1;
      inHunk = true;
    }

    if (hunk === hunkIndex) {
      matched = true;
      // Выбранный ханк → сторона копии: восстанавливаем её строки (del), новые
      // строки текущего файла (add) выкидываем.
      if (line.kind === 'del') out.push(line.text);
    } else {
      // Прочие ханки → оставляем как в текущем файле (add), сторону копии (del)
      // не возвращаем.
      if (line.kind === 'add') out.push(line.text);
    }
  }

  if (!matched) return undefined;

  const text = out.join('\n');
  // Финальный перевод строки берём у текущего файла: toLines его отбрасывает,
  // поэтому возвращаем, чтобы не «съесть» перевод строки в конце конфига.
  return currentText.endsWith('\n') && text !== '' ? `${text}\n` : text;
}

/** Результат выборочного отката ханка. Форма — как у restoreBackup. */
export interface RevertHunkResult {
  ok: boolean;
  restoredTo?: string;
  backupPath?: string;
  error?: string;
}

/**
 * Выборочный откат: вернуть ОДИН ханк из копии в текущий файл, не трогая
 * остального.
 *
 * Работает против ТЕКУЩЕГО файла на диске: дифф считается заново как
 * «копия → текущий файл», поэтому номер ханка совпадает с тем, что показан для
 * самой свежей копии (её дифф в ленте — ровно против текущего файла). Имя копии
 * приходит из запроса и проверяется как в buildDiff; цели — только известные
 * конфиг-файлы (файл секретов сюда не входит). Перед записью снимается копия
 * текущего состояния — откат тоже обратим.
 *
 * Копии файлов ПРОВАЙДЕРОВ откату не подлежат (`canRevert:false`) — отказываем до
 * любой записи. Это та же страховка, что и `canRestore:false` у полного отката
 * (Ф9-10): цель копии выводится по имени, и ошибка здесь означала бы запись
 * чужого конфига поверх файлов Claude.
 */
export function revertHunk(
  backupDir: string,
  name: string,
  hunkIndex: number,
  targets: TrackedFile[],
  backupTargetDir?: string,
): RevertHunkResult {
  if (basename(name) !== name || !BACKUP_NAME.test(name)) {
    return { ok: false, error: 'Копия не найдена' };
  }

  const byFile = collectSnapshots(backupDir, targets);
  for (const [file, snapshots] of byFile) {
    const snapshot = snapshots.find((item) => item.name === name);
    if (!snapshot) continue;

    const target = targets.find((item) => item.backupBase === file);
    if (!target) return { ok: false, error: 'Копия не найдена' };
    if (!target.canRevert) {
      return {
        ok: false,
        error: `Копия файла провайдера «${target.file}» доступна только для просмотра — откат отсюда не выполняется.`,
      };
    }

    const currentPath = target.path;
    if (!existsSync(currentPath)) {
      return { ok: false, error: 'Текущий файл не найден' };
    }

    const snapshotText = readText(snapshot.path);
    const currentText = readText(currentPath);

    if (isBinary(snapshotText) || isBinary(currentText)) {
      return { ok: false, error: 'Бинарный файл — построчный откат недоступен' };
    }
    if (tooBig(snapshotText, currentText)) {
      return { ok: false, error: 'Файл слишком большой — построчный откат недоступен' };
    }

    // before = копия, after = текущий файл: та же ориентация, что у диффа самой
    // свежей копии в ленте, поэтому индексы ханков совпадают.
    const { lines } = diffLines(snapshotText, currentText);
    const built = buildRevertedText(lines, hunkIndex, currentText);
    if (built === undefined) return { ok: false, error: 'Изменение не найдено' };
    if (built === currentText) return { ok: true, restoredTo: currentPath };

    const backupPath = writeTextFile(currentPath, built, { backupDir: backupTargetDir });
    return { ok: true, restoredTo: currentPath, backupPath };
  }

  return { ok: false, error: 'Копия не найдена' };
}

/**
 * Дифф одной копии против её базы. Считает +/− и, если файл в пределах лимитов
 * и не бинарный, отдаёт строки. skipped=true с причиной, когда показывать не
 * стоит. Внутренняя функция: пути уже проверены вызывающей стороной.
 */
function diffSnapshot(
  snapshot: Snapshot,
  base: { basePath?: string; label: BaseLabel },
): { added: number; removed: number; lines: DiffLine[]; skipped: boolean; reason?: string } {
  // Базы нет (первая известная версия) — сравнивать не с чем.
  if (base.label === 'initial') {
    return { added: 0, removed: 0, lines: [], skipped: true, reason: 'initial' };
  }

  const snapshotText = readText(snapshot.path);
  const baseText = readText(base.basePath);
  const { before, after } = orderVersions(snapshotText, baseText, base.label);

  if (isBinary(before) || isBinary(after)) {
    return { added: 0, removed: 0, lines: [], skipped: true, reason: 'binary' };
  }
  if (tooBig(before, after)) {
    return { added: 0, removed: 0, lines: [], skipped: true, reason: 'too-large' };
  }

  const { lines, added, removed } = diffLines(before, after);
  return { added, removed, lines, skipped: false };
}

/**
 * Лента изменений: по записи на каждую копию известного конфиг-файла, свежие
 * сверху. Для каждой записи — файл, время, метка базы и счётчики +N/−M. Строки
 * диффа в ленту не кладём — их отдаёт отдельный маршрут по имени копии.
 */
export function buildHistory(backupDir: string, targets: TrackedFile[]): HistoryEntry[] {
  const byFile = collectSnapshots(backupDir, targets);
  const entries: HistoryEntry[] = [];

  for (const [file, snapshots] of byFile) {
    const target = targets.find((item) => item.backupBase === file);
    if (!target) continue;

    snapshots.forEach((snapshot, index) => {
      const base = resolveBase(snapshots, index, target.path);
      const { added, removed } = diffSnapshot(snapshot, base);
      entries.push({
        name: snapshot.name,
        // Показываем basename файла, а не имя копии: префикс провайдера — деталь
        // хранения, в интерфейсе за неё отвечает отдельный бейдж.
        file: target.file,
        label: base.label,
        at: snapshot.at,
        added,
        removed,
        canRevert: target.canRevert,
        providerId: target.providerId,
        providerName: target.providerName,
      });
    });
  }

  // Свежие сверху: интересна последняя правка, а не первая.
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Полный дифф конкретной копии против её базы. Имя приходит из запроса, поэтому
 * проверяется по форме и наличию среди копий известных файлов — произвольный
 * путь сюда не проходит. Возвращает undefined, если такой копии нет.
 */
export function buildDiff(
  backupDir: string,
  name: string,
  targets: TrackedFile[],
): HistoryDiff | undefined {
  // Имя из запроса: без обхода каталога (только плоское имя копии нужной формы).
  if (basename(name) !== name || !BACKUP_NAME.test(name)) return undefined;

  const byFile = collectSnapshots(backupDir, targets);
  for (const [file, snapshots] of byFile) {
    const index = snapshots.findIndex((snapshot) => snapshot.name === name);
    if (index === -1) continue;

    const snapshot = snapshots[index]!;
    const target = targets.find((item) => item.backupBase === file);
    if (!target) return undefined;

    const base = resolveBase(snapshots, index, target.path);
    const { added, removed, lines, skipped, reason } = diffSnapshot(snapshot, base);
    // Нумеруем ханки, чтобы клиент мог предложить откат отдельного блока.
    assignHunks(lines);

    return {
      file: target.file,
      label: base.label,
      at: snapshot.at,
      lines,
      added,
      removed,
      skipped,
      reason,
      canRevert: target.canRevert,
      providerId: target.providerId,
      providerName: target.providerName,
    };
  }

  return undefined;
}
