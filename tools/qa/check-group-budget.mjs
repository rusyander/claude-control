/**
 * Бюджет первого запроса звена группы (B.6 плана экономии): настоящий `claude`
 * на стабе модели получает группу, собранную нынешними строителями панели, и
 * каждый блок запроса (всего, системный, инструменты, сообщения) сверяется с
 * пином `group-base-budget.json`: рост больше 2 тыс. знаков — красное. Плюс
 * инварианты в обе стороны — дописка ребёнка, строка «Тесты», задание и навык
 * звена на месте; дописки обычного чата и закрытых инструментов нет.
 *
 * Запуск: `node tools/qa/check-group-budget.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настоящий конфиг не трогаются. Рост по делу —
 * перепиновать: `node tools/qa/check-run-layers.mjs --group-base --synthetic
 * --pin tools/qa/group-base-budget.json`, и в коммите сказать, что выросло и зачем.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'cc-group-budget-'));
const run = spawnSync(
  process.execPath,
  [
    here('./check-run-layers.mjs'),
    '--group-base',
    '--synthetic',
    '--budget',
    here('./group-base-budget.json'),
    '--out',
    out,
  ],
  { stdio: 'inherit', windowsHide: true },
);
rmSync(out, { recursive: true, force: true });
process.exit(run.status ?? 1);
