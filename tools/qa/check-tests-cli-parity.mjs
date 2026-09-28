/**
 * `pnpm tests` и раздел «Тесты» видят одну и ту же библиотеку.
 *
 * CLI читает кейсы теми же модулями домена, что и сервер, — но это обещание, а
 * не доказательство: разъедься отбор (архив, части большой группы, сломанный
 * файл), и терминал с панелью молча показывали бы разное. Здесь сравниваются
 * НАСТОЯЩИЙ вывод команды и НАСТОЯЩИЙ ответ живого сервера на одном проекте:
 *
 *  1. `list` — те же группы, то же число кейсов, те же id и та же отметка статуса;
 *  2. `lint` — те же замечания, что отдаёт карточке «Здоровье» `GET /lint`.
 *
 * Ничего не пишет. Проект — `TESTS_PROJECT` (по умолчанию текущий каталог);
 * `CLI_PROJECT` подменяет каталог только для CLI — так проверка доказывает,
 * что умеет краснеть (чужой каталог обязан дать расхождение).
 *
 * Запуск: `node tools/qa/check-tests-cli-parity.mjs` при поднятом `pnpm dev`.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { apiFetch } from './api-auth.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:5178';
const project = resolve(process.env.TESTS_PROJECT ?? process.cwd());
const cliProject = resolve(process.env.CLI_PROJECT ?? project);

const MARK = { passed: '+', failed: 'X', skipped: '~', blocked: '!', running: '>', unknown: '.' };

const rows = [];
const check = (ok, what, detail = '') => {
  rows.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};

function cli(command) {
  const result = spawnSync(
    process.execPath,
    ['tools/tests-cli.mjs', command, '--project', cliProject],
    { encoding: 'utf8', windowsHide: true },
  );
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function api(path) {
  // Сервер недоступен — сказать это словами, а не стеком undici.
  const reachable = await apiFetch(`${API}/api/location`).then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.log(`✗ сервер ${API} не отвечает — сравнивать не с чем`);
    process.exit(1);
  }
  const response = await apiFetch(
    `${API}${path}${path.includes('?') ? '&' : '?'}path=${encodeURIComponent(project)}`,
  );
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

// 1. Список.
const view = await api('/api/project-tests');
const listed = cli('list');
check(listed.code === 0, '`tests list` отработал', `код ${listed.code}`);

const cliGroups = new Map();
let current;
for (const line of listed.out.split(/\r?\n/)) {
  const head = line.match(/^\[([^\]]+)\] .* — кейсов: (\d+)$/);
  if (head) {
    current = { count: Number(head[2]), cases: new Map() };
    cliGroups.set(head[1], current);
    continue;
  }
  const row = line.match(/^ {2}(\S) (\S+)\s/);
  if (row && current) current.cases.set(row[2], row[1]);
}

const apiGroups = view.groups.filter((group) => !group.error);
check(
  cliGroups.size === apiGroups.length,
  'число групп совпадает',
  `CLI ${cliGroups.size}, панель ${apiGroups.length}`,
);
let caseMismatch = 0;
for (const group of apiGroups) {
  const mine = cliGroups.get(group.id);
  if (!mine) {
    check(false, `группа ${group.id} есть в CLI`);
    continue;
  }
  const sameCount = mine.count === group.cases.length;
  if (!sameCount)
    check(false, `кейсов в ${group.id}`, `CLI ${mine.count}, панель ${group.cases.length}`);
  for (const item of group.cases) {
    const mark = mine.cases.get(item.id);
    if (mark !== (MARK[item.status] ?? '.')) {
      caseMismatch += 1;
      if (caseMismatch <= 5) {
        console.log(`  ${group.id}/${item.id}: CLI «${mark ?? 'нет'}», панель «${item.status}»`);
      }
    }
  }
}
const totalCases = apiGroups.reduce((sum, group) => sum + group.cases.length, 0);
check(
  caseMismatch === 0,
  'id и статус каждого кейса совпадают',
  `расхождений ${caseMismatch} из ${totalCases}`,
);

// 2. Замечания набора.
const lint = await api('/api/project-tests/lint');
const linted = cli('lint');
check(linted.code === 0, '`tests lint` отработал', `код ${linted.code}`);
// Строка CLI: «важность группа/кейс заголовок — сообщение [исправление]». Тире
// бывает и в заголовке, и в самом сообщении («…такого нет — подставлять
// нечего»), поэтому строка не режется по тире, а сверяется хвостом: замечание
// панели совпало, если строка того же кейса кончается на « — <сообщение>».
// Прежде `.* — ` съедал всё до последнего тире, и сообщение с тире внутри
// расходилось с панелью на ровном месте (28.09, testing-014).
const cliLines = linted.out
  .split(/\r?\n/)
  // Любая важность (X ошибка, ! предупреждение, · заметка) и без хвоста
  // «[исправление]»: прежде сверялись только заметки, и предупреждение,
  // которого нет в одной из сторон, проходило незамеченным.
  .map((line) => line.match(/^ {2}[X!·] ([^/\s]+)\/(\S+) (.+?)(?: \[[^\]]*\])?$/))
  .filter(Boolean)
  .map((match) => ({ key: `${match[1]}/${match[2]}`, rest: match[3].trim() }));
const apiItems = (lint.findings ?? []).map((item) => ({
  key: `${item.groupId}/${item.caseId}`,
  message: String(item.message).trim(),
}));
const matches = (line, item) => line.key === item.key && line.rest.endsWith(` — ${item.message}`);
const cliFindings = new Set(cliLines.map((line) => `${line.key} ${line.rest}`));
const apiFindings = new Set(apiItems.map((item) => `${item.key} ${item.message}`));
const onlyApi = apiItems
  .filter((item) => !cliLines.some((line) => matches(line, item)))
  .map((item) => `${item.key} ${item.message}`);
const onlyCli = cliLines
  .filter((line) => !apiItems.some((item) => matches(line, item)))
  .map((line) => `${line.key} ${line.rest}`);
check(
  onlyApi.length === 0 && onlyCli.length === 0,
  'замечания CLI = замечания карточки «Здоровье»',
  `панель ${apiFindings.size}, CLI ${cliFindings.size}, только в панели ${onlyApi.length}, только в CLI ${onlyCli.length}`,
);
for (const item of [...onlyApi, ...onlyCli].slice(0, 5)) console.log(`  ${item}`);

const failed = rows.filter((ok) => !ok).length;
console.log(
  failed ? `\nПровалено: ${failed} из ${rows.length}` : `\nВсе проверки прошли (${rows.length}).`,
);
// exitCode, а не exit(): выход посреди закрытия сокетов fetch роняет Node на
// Windows (libuv `UV_HANDLE_CLOSING`, код 127) — зелёный прогон читался бы красным.
process.exitCode = failed ? 1 : 0;
