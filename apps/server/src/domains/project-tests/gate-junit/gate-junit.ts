import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testsPath } from '../files.ts';

/**
 * Отчёт ворот проекта — в блок «Тесты» без второго прогона (F2, g0 27.10).
 *
 * Группа прогнала ворота фронта (`vitest related`, 3:37), а через пять минут на том же
 * дереве `run --stale` гонял те же наборы снова (1:39). Ворота, что пишут JUnit, кладут
 * его в `.agent/tests/gate-junit/<имя>.xml` и рядом `<имя>.tree` — отпечаток дерева на
 * СТАРТЕ ворот (`tests-cli tree --out …`). `run --stale` до прогона забирает отчёты, чей
 * отпечаток равен нынешнему дереву: их кейсы засчитаны и не гоняются; отчёт другого
 * дерева — не довод, он называется и остаётся. Отпечаток — `check-memo treeFingerprint`
 * (HEAD + дифф + неотслеживаемые, `.agent` вне счёта), тот же, что у `run` и `import --tree`.
 */

export const GATE_JUNIT_DIR = 'gate-junit';

export interface GateReport {
  name: string;
  xml: string;
  /** Отпечаток дерева со старта ворот; нет файла `.tree` — `undefined`. */
  tree?: string;
}

/** Отчёты ворот в папке копии: пары `<имя>.xml` + `<имя>.tree`. */
export function gateReports(root: string): GateReport[] {
  const dir = testsPath(root, GATE_JUNIT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.xml'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.xml'.length);
      const treeFile = join(dir, `${name}.tree`);
      const tree = existsSync(treeFile) ? readFileSync(treeFile, 'utf8').trim() : '';
      return { name, xml: join(dir, file), ...(tree ? { tree } : {}) };
    });
}

/** Забранный отчёт убирается парой — второй раз он не засчитается. */
export function dropGateReport(report: GateReport): void {
  rmSync(report.xml, { force: true });
  rmSync(report.xml.replace(/\.xml$/, '.tree'), { force: true });
}
