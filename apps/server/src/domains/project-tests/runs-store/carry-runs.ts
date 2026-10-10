import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { listFiles, readJson, TESTS_DIR } from '../files.ts';
import { runFileId, writeRun } from './runs-store.ts';

/**
 * Прогоны блока «Тесты», сделанные в копии ветки, — в историю основного
 * проекта, пока копию не убрали (F-5).
 *
 * Хранилище кейсов едет в копию зеркалом (`.agent/**`), и группа разделения
 * пишет свои прогоны в СВОЮ `.agent/tests/runs/`. Удаление копии уносило их с
 * собой: ни отчёт, ни нестабильные кейсы, ни история кейса о работе группы
 * больше не знали. Переносятся записи, которых в основном проекте нет (по
 * имени файла: зеркало привезло в копию и старые прогоны основного), и
 * вложения, на которые ссылаются их результаты. Своя запись основного не
 * переписывается никогда. Хвост сверх `KEEP` срезает сама запись прогона.
 */
export interface CarriedRuns {
  runs: number;
  attachments: number;
  /** Записи, которые записать не вышло: копию убирать нельзя, иначе они пропадут. */
  failed: number;
  /** Битые записи копии: переносить нечего, удалению копии они не мешают. */
  unreadable: number;
}

const SUFFIX = '.run.json';

export function carryCopyRuns(copyDir: string, rootDir: string): CarriedRuns {
  const done: CarriedRuns = { runs: 0, attachments: 0, failed: 0, unreadable: 0 };
  const own = new Set(listFiles(rootDir, 'runs', SUFFIX));
  for (const fileId of listFiles(copyDir, 'runs', SUFFIX)) {
    if (own.has(fileId)) continue;
    const { data } = readJson(copyDir, `runs/${fileId}${SUFFIX}`);
    const record = data as ProjectTestRunRecord | undefined;
    if (!record || typeof record !== 'object' || typeof record.startedAt !== 'string') {
      done.unreadable += 1;
      continue;
    }
    // Запись по своему же имени: `writeRun` строит его из id и времени — совпадёт.
    if (own.has(runFileId(String(record.id ?? ''), record.startedAt))) continue;
    try {
      done.attachments += carryAttachments(record, copyDir, rootDir);
      writeRun(rootDir, record);
      done.runs += 1;
    } catch {
      done.failed += 1;
    }
  }
  return done;
}

/** Вложения результатов: путь в записи — от корня проекта, он тот же в обоих. */
function carryAttachments(record: ProjectTestRunRecord, copyDir: string, rootDir: string): number {
  let count = 0;
  for (const result of record.results ?? []) {
    for (const file of result.attachments ?? []) {
      const relative = typeof file === 'string' ? file : '';
      if (!relative.startsWith(`${TESTS_DIR}/attachments/`) || relative.includes('..')) continue;
      const from = join(copyDir, ...relative.split('/'));
      const to = join(rootDir, ...relative.split('/'));
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}
