import { basename } from 'node:path';
import type { DiffLine, HistoryDiff, HistoryEntry } from '@claude-control/contracts';
import type { TrackedFile } from '../tracked-files.ts';
import { BACKUP_NAME } from './constants.ts';
import { assignHunks, diffLines, isBinary, tooBig } from './diff.ts';
import { collectSnapshots, orderVersions, readText, resolveBase } from './snapshots.ts';
import type { DiffBase, Snapshot } from './types.ts';

/**
 * Лента правок и полный дифф одной копии — чтение истории.
 *
 * Направление диффа — хронологически вперёд (старое → новое), чтобы «+N/−M»
 * читались как «столько добавили/убрали этой правкой»; какая версия чему база,
 * решает `resolveBase` (см. snapshots.ts).
 */

/**
 * Дифф одной копии против её базы. Считает +/− и, если файл в пределах лимитов
 * и не бинарный, отдаёт строки. skipped=true с причиной, когда показывать не
 * стоит. Внутренняя функция: пути уже проверены вызывающей стороной.
 */
function diffSnapshot(
  snapshot: Snapshot,
  base: DiffBase,
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
      const { added, removed, skipped, reason } = diffSnapshot(snapshot, base);
      entries.push({
        name: snapshot.name,
        // Показываем basename файла, а не имя копии: префикс провайдера — деталь
        // хранения, в интерфейсе за неё отвечает отдельный бейдж.
        file: target.file,
        label: base.label,
        at: snapshot.at,
        added,
        removed,
        // Пропуск диффа (бинарный / слишком большой) едет в ленту: нули у такой
        // записи — не «без изменений», и шапка должна назвать причину.
        ...(skipped ? { skipped, reason } : {}),
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
