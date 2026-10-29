import { join } from 'node:path';
import { createExclusive, pathExists, readBytesSync } from '../../platform/safe-io/files.ts';
import { readJournalLines } from '../read-lines.ts';
import { snapshotPath } from '../snapshot.ts';

/**
 * Читатель под нагрузкой (P55): отдельный процесс читает журнал и снимок, пока владелец пишет
 * и заменяет снимок. Любая битая строка в середине журнала или недочитанный снимок — ошибка.
 *
 * Перекрытие с писателем доказывается рукопожатием, а не скоростью: после первого чтения
 * читатель кладёт `ready-<pid>` в каталог управления (писатель ждёт всех), читает до файла
 * `stop` (писатель кладёт его, закончив) и делает ещё одно чтение после него. Так каждый
 * читатель видит состояние до первой записи и после последней, как бы ни была загружена машина.
 */
const [dir = '', taskId = '', ctlDir = '', deadline = '0'] = process.argv.slice(2);
let reads = 0;
let firstSeq = -1;
let lastSeq = -1;
const errors: string[] = [];

function readOnce(): void {
  try {
    const read = readJournalLines(dir, taskId);
    if (firstSeq < 0) firstSeq = read.lines.length;
    lastSeq = read.lines.length;
    const snap = readBytesSync(snapshotPath(dir));
    if ('unknown' in snap) errors.push(`snapshot unreadable: ${snap.unknown}`);
    if ('value' in snap) JSON.parse(snap.value.toString('utf8'));
    reads += 1;
  } catch (error) {
    errors.push(String(error));
  }
}

readOnce();
createExclusive(join(ctlDir, `ready-${process.pid}`), '');
let stopped = false;
while (!stopped && Date.now() < Number(deadline)) {
  stopped = pathExists(join(ctlDir, 'stop'));
  readOnce();
}
process.stdout.write(
  `${JSON.stringify({ reads, firstSeq, lastSeq, stopped, errors: errors.slice(0, 5), errorCount: errors.length })}\n`,
);
