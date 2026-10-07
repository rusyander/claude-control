/**
 * Агент блока «Тесты» на чужом CLI — настоящими qwen (`--approval-mode yolo` +
 * хук к приёмнику прав панели) и codex (`app-server`, ответы на его просьбы)
 * через настоящую панель. Аргумент — один CLI (`qwen` | `codex`); без
 * аргумента — оба, каждый своим процессом (так кейс блока «Тесты» гоняет обоих
 * одним файлом).
 *
 * Подменена только модель (`stub-tests-agent-model.mjs`, сетевая граница), и она
 * идёт по сценарию: разрешённая запись (файл группы / черновик / файл автотеста
 * / спека e2e), запись `src/evil.ts` вне границ прогона, `git commit -am x`,
 * печать `STAND_TOKEN` оболочкой, итоговый текст со значением доступа. Режимы:
 * run, explore, automate, generate, generate+e2e; у Qwen ещё «приёмник упал
 * посреди прогона» (адрес приёмника подменяется перед записью вне границ — хук
 * обязан отказать, а не пропустить).
 *
 * Доказательства — файлы и провод, не рассуждения модели: файл группы изменён и
 * несёт `lastRunId` прогона; `src/evil.ts` нет; ссылки git те же; причина отказа
 * — в СЛЕДУЮЩЕМ запросе к модели (у Codex это и есть доказательство подсказки
 * в ход); запись прогона — done, провайдер, токены; значение доступа дошло до
 * модели с результатом команды и затёрто в логе и записи; черновик разобран;
 * спека и метка e2e на диске; ни одного процесса CLI под панелью после
 * прогона; настоящие `~/.qwen`, `~/.codex`, `~/.claude*`, `~/.agents` не тронуты.
 *
 * CLI — из `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH. Нет
 * его — «не проверено» (код 2), не провал. Дом CLI — временный каталог.
 * `TESTS_AGENT_ONLY=run,gatedown` — только эти сценарии; `TESTS_AGENT_SERVER_DIR`
 * — каталог сервера для стенда (подопытная копия для мутантов).
 *
 * Код выхода: 0 — всё сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_SESSION_CHURN,
  NotChecked,
  diffRealProviderDirs,
  freePort,
  reporter,
  snapshotRealProviderDirs,
  startStand,
  wait,
} from './throwaway-stand.mjs';
import { startScriptedModel } from './stub-tests-agent-model.mjs';

const IS_WIN = process.platform === 'win32';
// Значение доступа стенда — своё на запуск: по нему ищем утечку в логе.
const STAND_VALUE = ['qa', 'stand', randomBytes(4).toString('hex')].join('-');
const GROUP_FILE = '.agent/tests/gui.tests.json';
const AUTOMATION_FILE = 'tests/gui-001.spec.ts';
const ALL = ['run', 'explore', 'automate', 'generate', 'generate-e2e', 'gatedown', 'session'];
// Сценарии одного CLI: «приёмник упал» — у хука Qwen, «правка, одобренная на
// сессию» — у Codex (второй правкой тот же файл уезжает за границы).
const ONLY_FOR = { gatedown: 'qwen', session: 'codex' };

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Все процессы машины: pid, родитель, командная строка. */
function processTable() {
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    return rows
      .split(/\r?\n/)
      .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/))
      .filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] }));
  } catch {
    return [];
  }
}

/** Pid, слушающий порт (сервер стенда), — от него считаются потомки. */
function listenerPid(port) {
  try {
    const out = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`,
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Потомки сервера стенда, похожие на чужой CLI. Прочие CLI машины (параллельные
 * проверки человека) сюда не попадают: считаем только дерево ЭТОЙ панели.
 */
function cliDescendants(serverPid, cli) {
  if (!serverPid) return [];
  const table = processTable();
  const out = [];
  const queue = [serverPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of table) {
      if (row.ppid !== parent || row.pid === parent) continue;
      queue.push(row.pid);
      if (new RegExp(cli, 'i').test(row.cmd)) out.push(row);
    }
  }
  return out;
}

const git = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', ...args], {
    cwd,
    encoding: 'utf8',
  });
const refsOf = (cwd) =>
  `${git(cwd, 'for-each-ref').stdout}\n${git(cwd, 'rev-parse', 'HEAD').stdout}`;

/** Окружение CLI на стенд: адрес заглушки и временный дом. */
const CLIS = {
  qwen: (root, base) => {
    const home = join(root, 'qwen-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'openai' } } }),
    );
    return {
      QWEN_HOME: home,
      OPENAI_BASE_URL: `${base}/v1`,
      OPENAI_API_KEY: 'x',
      OPENAI_MODEL: 'stub-model',
    };
  },
  codex: (root, base) => {
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    // `gpt-5.5` — известный Codex идентификатор: только ему он предлагает
    // apply_patch (проба P6), а правки файлов и есть то, что здесь проверяется.
    writeFileSync(
      join(home, 'config.toml'),
      [
        'model_provider = "stub"',
        'model = "gpt-5.5"',
        'check_for_update_on_startup = false',
        '[analytics]',
        'enabled = false',
        '[features]',
        'plugins = false',
        '[model_providers.stub]',
        'name = "stub"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        'env_key = "STUB_KEY"',
        '',
      ].join('\n'),
    );
    return { CODEX_HOME: home, STUB_KEY: 'x' };
  },
};

if (!process.argv[2]) {
  const codes = Object.keys(CLIS).map((cli) => {
    console.log(`\n=== ${cli} ===`);
    return spawnSync(process.execPath, [fileURLToPath(import.meta.url), cli], { stdio: 'inherit' })
      .status;
  });
  if (codes.includes(1) || codes.includes(null)) process.exit(1);
  process.exit(codes.includes(2) ? 2 : 0);
}
const CLI = process.argv[2];
if (!CLIS[CLI]) {
  console.log(`Неизвестный CLI «${CLI}»: ${Object.keys(CLIS).join(', ')}`);
  process.exit(1);
}
const cliDir = findCli(CLI);
if (!cliDir) {
  console.log(`Не проверено: ${CLI} нет ни в STEER_CLI_DIR, ни в PATH.`);
  process.exit(2);
}
const only = (process.env.TESTS_AGENT_ONLY ?? '').split(',').filter(Boolean);
const scenarios = ALL.filter((name) => (ONLY_FOR[name] ?? CLI) === CLI).filter(
  (name) => only.length === 0 || only.includes(name),
);
const { check, finish } = reporter();

// Шаги модели — инструментами своего CLI.
const TOOLS = {
  qwen: {
    write: (root, file, content) => ({
      tool: { name: 'write_file', args: { file_path: join(root, file), content } },
    }),
    // Qwen не перезаписывает файл, не прочитанный в этой сессии: сначала чтение.
    read: (root, file) => ({
      tool: {
        name: 'read_file',
        args: { absolute_path: join(root, file), file_path: join(root, file) },
      },
    }),
    update: (root, file, next) => TOOLS.qwen.write(root, file, next),
    shell: (command) => ({
      tool: {
        name: 'run_shell_command',
        args: { command, is_background: false, description: 'qa' },
      },
    }),
  },
  codex: {
    write: (_root, file, content) => ({
      custom: {
        name: 'apply_patch',
        input: `*** Begin Patch\n*** Add File: ${file}\n${content
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n')}\n*** End Patch\n`,
      },
    }),
    // Правка одной строки с соседом выше: apply_patch ищет кусок по содержимому.
    update: (root, file, next) => {
      const before = readFileSync(join(root, file), 'utf8').split('\n');
      const after = next.split('\n');
      const at = before.findIndex((line, index) => line !== after[index]);
      if (at < 1 || before.length !== after.length) throw new Error('правка не в одну строку');
      return {
        custom: {
          name: 'apply_patch',
          input: `*** Begin Patch\n*** Update File: ${file}\n@@\n ${before[at - 1]}\n-${before[at]}\n+${after[at]}\n*** End Patch\n`,
        },
      };
    },
    read: undefined,
    shell: (cmd) => ({ tool: { name: 'exec_command', args: { cmd } } }),
  },
};
const T = TOOLS[CLI];
// Печать переменной — через node: оболочки CLI разные (cmd у Qwen, PowerShell у
// Codex), а кавычек в строке нет — обёртка `-Command '…'` их не ломает.
const TOKEN_LINE = 'node -p process.env.STAND_TOKEN';

/**
 * Вторая правка уже одобренного файла группы — с переносом в `src/evil.ts`. Путь
 * правки тот же, что одобрен в первой; одобрение «на сессию» вместо «один раз»
 * пропустило бы её без вопроса.
 */
function moveOut(root) {
  const lines = readFileSync(join(root, GROUP_FILE), 'utf8').split('\n');
  const at = lines.findIndex((line) => line.includes('"status": "passed"'));
  if (at < 1) throw new Error('в файле группы нет статуса passed');
  return {
    custom: {
      name: 'apply_patch',
      input: `*** Begin Patch\n*** Update File: ${GROUP_FILE}\n*** Move to: src/evil.ts\n@@\n ${lines[at - 1]}\n-${lines[at]}\n+${lines[at].replace('passed', 'failed')}\n*** End Patch\n`,
    },
  };
}

/** Файл группы с одним изменённым статусом — то, что пишет прогон. */
function groupUpdate(root) {
  const lines = readFileSync(join(root, GROUP_FILE), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.includes('"id": "gui-001"'));
  const at = lines.findIndex((line, index) => index > start && /^ {6}"status": "/.test(line));
  if (start < 0 || at < 0) throw new Error(`в ${GROUP_FILE} нет статуса gui-001`);
  lines[at] = lines[at].replace(/"status": "[^"]*"/, '"status": "passed"');
  return lines.join('\n');
}

function draftJson(runId) {
  return JSON.stringify(
    {
      version: 1,
      runId,
      source: 'code',
      createdAt: new Date().toISOString(),
      items: [
        {
          op: 'add',
          groupId: 'gui',
          caseId: 'gui-003',
          case: {
            id: 'gui-003',
            title: 'Новый кейс от агента',
            steps: [{ action: 'открыть главную', expected: 'видна шапка' }],
          },
          reason: 'проверка агента тестов',
        },
      ],
    },
    null,
    2,
  );
}

/** Разрешённые шаги режима — до шагов, которые панель обязана отказать. */
function allowedSteps(name, root, runId) {
  const draft = () => T.write(root, `.agent/tests/drafts/${runId}.draft.json`, draftJson(runId));
  const group = () => T.update(root, GROUP_FILE, groupUpdate(root));
  const read = T.read ? [() => T.read(root, GROUP_FILE)] : [];
  if (name === 'generate') return [draft];
  if (name === 'generate-e2e') {
    return [
      draft,
      () => T.write(root, 'e2e/gui.spec.ts', '// [gui-003] главная открывается\nexport {};'),
      () =>
        T.write(
          root,
          'e2e/mark.cjs',
          "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'run.marker'), 'ok');",
        ),
      () => T.shell('node e2e/mark.cjs'),
    ];
  }
  if (name === 'automate') {
    return [
      ...read,
      group,
      () => T.write(root, AUTOMATION_FILE, '// [gui-001] автотест кейса\nexport {};'),
    ];
  }
  return [...read, group];
}

/** Проект сценария: git, группа из двух кейсов, окружение с доступом стенда. */
async function seedProject(stand, name, mode, project) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# qa\n');
  git(project, 'init', '-q');
  const api = async (path, body) => {
    const response = await stand.api(path, { method: 'POST', body });
    if (response.status >= 400) {
      throw new Error(`${path}: ${response.status} ${response.text.slice(0, 300)}`);
    }
    return response.body;
  };
  await api('/projects', { name: `qa-${name}`, path: project });
  await api('/project-tests/group', { path: project, id: 'gui', title: 'GUI' });
  for (const title of ['Открытие главной', 'Вход']) {
    await api('/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: {
        title,
        steps: [{ action: 'открыть', expected: 'видно' }],
        ...(title === 'Открытие главной' && mode === 'automate'
          ? { automation: { status: 'toAutomate', file: AUTOMATION_FILE } }
          : {}),
      },
    });
  }
  const view = await api('/project-tests/environment', {
    path: project,
    environment: { title: 'Стенд', baseUrl: 'http://127.0.0.1:9', isDefault: true },
  });
  await api('/project-tests/env-secret', {
    path: project,
    environmentId: view.environments[0].id,
    name: 'STAND_TOKEN',
    value: STAND_VALUE,
  });
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'seed');
}

/**
 * «Приёмник упал»: адрес в файле приёмника прогона (временный каталог Qwen-прогона
 * панели) — на закрытый порт. Хуку это неотличимо от остановленного приёмника.
 */
async function dropGate(since) {
  const dead = `http://127.0.0.1:${await freePort()}/`;
  const dirs = readdirSync(tmpdir())
    .filter((entry) => entry.startsWith('cc-tests-qwen-'))
    .map((entry) => join(tmpdir(), entry))
    .filter((dir) => existsSync(join(dir, 'gate.json')) && statSync(dir).mtimeMs >= since - 2000);
  for (const dir of dirs) {
    const gate = JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8'));
    writeFileSync(join(dir, 'gate.json'), JSON.stringify({ ...gate, url: dead }));
  }
  return dirs.length;
}

/** Один сценарий: свой проект, свой прогон, доказательства по файлам и проводу. */
async function scenario(stand, model, serverPid, name, root) {
  console.log(`\n— ${CLI}: ${name}`);
  const mode = { 'generate-e2e': 'generate', gatedown: 'run', session: 'run' }[name] ?? name;
  const project = join(root, `p-${name}`);
  await seedProject(stand, name, mode, project);
  const refs = refsOf(project);
  const groupBefore = readFileSync(join(project, GROUP_FILE), 'utf8');

  let runId;
  let ready;
  const started = new Promise((resolve) => (ready = resolve));
  const from = model.bodies.length;
  const marks = {};
  let dropped;
  let steps;
  const runStart = Date.now();
  model.script.current = async (index) => {
    await started;
    steps ??= [
      ...allowedSteps(name, project, runId),
      {
        mark: 'evil',
        step: () =>
          name === 'session'
            ? moveOut(project)
            : T.write(project, 'src/evil.ts', 'export const evil = 1;'),
      },
      { mark: 'commit', step: () => T.shell('git commit -am x') },
      { mark: 'token', step: () => T.shell(TOKEN_LINE) },
      () => ({ text: `DONE TOKEN=${STAND_VALUE}` }),
    ];
    const step = steps[index - from];
    if (!step) return { text: 'DONE' };
    if (!step.mark) return step();
    marks[step.mark] = index;
    if (step.mark === 'evil' && name === 'gatedown') dropped = await dropGate(runStart);
    return step.step();
  };

  const response = await stand.api('/project-tests/run', {
    method: 'POST',
    body: {
      path: project,
      mode,
      groupId: 'gui',
      ...(name === 'generate-e2e' ? { e2e: true } : {}),
      // Исследование без хартии панель не запускает.
      ...(mode === 'explore' ? { scope: 'главная страница' } : {}),
    },
  });
  if (
    !check(
      'прогон принят',
      response.status === 200 && response.body?.run?.id,
      `${response.status} ${response.text.slice(0, 400)}`,
    )
  ) {
    model.script.current = undefined;
    return;
  }
  runId = response.body.run.id;
  ready();

  const query = `path=${encodeURIComponent(project)}`;
  let record;
  for (let i = 0; i < 360; i += 1) {
    record = (await stand.api(`/project-tests/runs?${query}`)).body?.runs?.find(
      (item) => item.id === runId,
    );
    if (record && record.status !== 'running') break;
    await wait(500);
  }
  record = (await stand.api(`/project-tests/run?${query}&id=${runId}`)).body?.run ?? record;
  const count = model.bodies.length - from;
  // Разбор провала: тела запросов к модели и запись прогона — в каталог по запросу.
  if (process.env.TESTS_AGENT_DUMP) {
    mkdirSync(process.env.TESTS_AGENT_DUMP, { recursive: true });
    writeFileSync(
      join(process.env.TESTS_AGENT_DUMP, `${CLI}-${name}.json`),
      JSON.stringify({ marks, from, bodies: model.bodies.slice(from), record }, null, 2),
    );
  }
  const after = (mark) => (marks[mark] === undefined ? '' : (model.bodies[marks[mark] + 1] ?? ''));

  check(
    'прогон кончился «done», провайдер записан',
    record?.status === 'done' && record?.provider === CLI,
    `${record?.status} ${record?.provider} ${record?.messageCode ?? ''} ${record?.error ?? ''}\n    ${(record?.log ?? '').slice(-800)}`,
  );
  check('src/evil.ts не появился', !existsSync(join(project, 'src', 'evil.ts')));
  check('ссылки git те же (коммита нет)', refsOf(project) === refs);
  if (name === 'gatedown') {
    check('файл приёмника прогона найден ровно один', dropped === 1, `найдено ${dropped}`);
    check(
      'приёмник недоступен — хук отказал, причина в следующем запросе',
      after('evil').includes('could not check this call'),
      `запросов ${count}`,
    );
  } else {
    check(
      'отказ записи вне границ — причина в следующем запросе к модели',
      after('evil').includes('is forbidden for this run'),
      `запросов ${count}; след: ${after('evil').slice(-300)}`,
    );
    check(
      'отказ git commit — причина в следующем запросе к модели',
      after('commit').includes('Commands that change the repository are forbidden'),
      `запросов ${count}`,
    );
    check(
      'значение доступа дошло до модели с результатом команды',
      after('token').includes(STAND_VALUE),
      `запросов ${count}`,
    );
  }
  // Лог живёт в виде раздела (в записи истории его нет); итоговый текст модели
  // несёт значение — без затирания оно было бы в логе.
  const live = (await stand.api(`/project-tests?${query}`)).body?.run;
  check(
    'итог модели дошёл до лога прогона',
    live?.id === runId && (live?.log ?? '').includes('DONE TOKEN='),
    (live?.log ?? '').slice(-400),
  );
  check(
    'значения доступа нет ни в логе, ни в записи прогона',
    !JSON.stringify(live ?? {}).includes(STAND_VALUE) &&
      !JSON.stringify(record ?? {}).includes(STAND_VALUE),
  );
  check('токены посчитаны', (record?.tokens ?? 0) > 0, `tokens=${record?.tokens}`);

  if (mode === 'generate') {
    check('черновик записан', existsSync(join(project, `.agent/tests/drafts/${runId}.draft.json`)));
    check(
      'черновик разобран панелью',
      (record?.draft?.proposed ?? 0) >= 1 &&
        (name !== 'generate-e2e' || (record?.draft?.accepted ?? 0) >= 1),
      JSON.stringify(record?.draft),
    );
    if (name === 'generate') {
      check(
        'файл группы генерацией не тронут',
        readFileSync(join(project, GROUP_FILE), 'utf8') === groupBefore,
      );
    } else {
      check('спека e2e записана', existsSync(join(project, 'e2e', 'gui.spec.ts')));
      check(
        'команда e2e выполнена (метка на диске)',
        existsSync(join(project, 'e2e', 'run.marker')),
      );
    }
  } else {
    const group = JSON.parse(readFileSync(join(project, GROUP_FILE), 'utf8'));
    const first = group.cases.find((item) => item.id === 'gui-001');
    check(
      'файл группы изменён, кейс несёт lastRunId прогона',
      first?.status === 'passed' && first?.lastRunId === runId,
      `${first?.status} ${first?.lastRunId} ≠ ${runId}`,
    );
    if (mode === 'automate') {
      check('файл автотеста записан', existsSync(join(project, AUTOMATION_FILE)));
    }
  }
  await wait(1500);
  const left = cliDescendants(serverPid, CLI);
  check(
    'процесса CLI под панелью не осталось',
    left.length === 0,
    left.map((row) => `${row.pid} ${row.cmd}`).join('\n    '),
  );
  model.script.current = undefined;
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tagent-')));
const script = { current: undefined };
const model = await startScriptedModel((index, bodies) =>
  script.current ? script.current(index, bodies) : { text: 'DONE' },
);
model.script = script;
const realBefore = snapshotRealProviderDirs();
let stand;
let exitCode;
try {
  stand = await startStand({
    web: false,
    label: `tests-agent-${CLI}`,
    settings: { provider: CLI },
    extraPath: [cliDir],
    env: CLIS[CLI](root, model.base),
    ...(process.env.TESTS_AGENT_SERVER_DIR
      ? { serverDir: process.env.TESTS_AGENT_SERVER_DIR }
      : {}),
  });
  console.log(`Одноразовая панель ${stand.apiUrl}, сценарии: ${scenarios.join(', ')}`);
  const serverPid = listenerPid(new URL(stand.apiUrl).port);
  check('сервер стенда найден по порту', serverPid !== undefined);
  for (const name of scenarios) {
    try {
      await scenario(stand, model, serverPid, name, root);
    } catch (error) {
      model.script.current = undefined;
      check(`сценарий ${name} дошёл до конца`, false, error?.stack ?? String(error));
    }
  }
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    exitCode = 2;
  } else check('проверка дошла до конца', false, error?.stack ?? String(error));
} finally {
  if (stand) await stand.stop();
  await model.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Каталог держит вышедший позже процесс CLI — это не результат проверки.
  }
}
// Зеркало агентских документов проекта в `~/.claude/project-configs` пишут хуки
// живой сессии Claude человека, пока идёт проверка, — не стенд (у него свой дом).
const changed = diffRealProviderDirs(realBefore, snapshotRealProviderDirs(), {
  ignore: [...LIVE_SESSION_CHURN, /\/\.claude\/project-configs(\/|$)/],
});
check(
  'настоящие каталоги CLI человека не тронуты',
  changed.length === 0,
  changed.map((entry) => `${entry.path}: ${entry.before} → ${entry.after}`).join('\n    '),
);
if (exitCode !== undefined) process.exit(exitCode);
finish();
