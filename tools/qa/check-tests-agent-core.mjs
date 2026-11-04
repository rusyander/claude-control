/**
 * Агент блока «Тесты» идёт задачей ядра (этап 10, зона F6) — настоящая дорога: одноразовая
 * панель + своё ядро (`startStand({ core })`), запуск через `POST /api/project-tests/run`, ядро
 * поднимает НАСТОЯЩИЙ `claude` дорогой входа CLI, а тот ходит в заглушку `packages/stub-model`
 * (адрес и подставной ключ — в settings.json стенда). Подменена только модель на границе сети;
 * панель свой CLI больше не запускает.
 *
 * Сценарий модели: один вызов `Write` в `src/evil.ts` (вне границ режима «Прогон»), затем
 * итоговый текст. Что видно:
 *   - прогон доходит до конца без человека (`end-chat` на первом конце хода): статус не
 *     `running`, провайдер `claude`, итоговый текст модели — в логе прогона;
 *   - запрос к модели несёт строку границ (`scopeClause`) — граница сказана в задании;
 *   - запись вне границ ОТКАЗАНА судьёй ядра: границы режима — `task.created.session.scope`,
 *     в журнале отказ `outside-scope`, файла на диске нет, сверке на финише ловить нечего;
 *   - задача ядра одна, размещена на месте (in-place) с грантом `edit` на корень проекта;
 *   - модель вызвана (запросы в следе заглушки) — ход шёл через ядро, не мимо него.
 *
 * Запуск: `node tools/qa/check-tests-agent-core.mjs` (стенд свой, `pnpm dev` не нужен; нужен
 * `claude` в PATH — нет его, «не проверено», код 2). Код выхода: 0 — сходится, 1 — провал.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const MARK = 'TESTS-CORE-STUB-DONE';

function claudeDir() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
    });
    const first = out.split(/\r?\n/).find(Boolean);
    return first ? dirname(first) : '';
  } catch {
    return '';
  }
}

const cliDir = claudeDir();
if (!cliDir) {
  console.log('Не проверено: claude нет в PATH');
  process.exit(2);
}

let project = '';
let evilPath = '';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Сценарий модели: в ходе с инструментом `Write` и без результата инструмента — запись вне
 * границ; после результата и на служебные запросы CLI (заголовок разговора и т. п.) — итог.
 */
const stub = await startStubModel({
  script: (ctx) => {
    if (ctx.info.hasToolResult) return `${MARK}: прогон окончен`;
    if (ctx.info.tools.some((tool) => tool.name === 'Write') && evilPath) {
      return {
        tool: { name: 'Write', args: { file_path: evilPath, content: 'export const x = 1;\n' } },
      };
    }
    return `${MARK}: прогон окончен`;
  },
});

await runOnStand(
  {
    label: 'tests-core',
    web: false,
    extraPath: [cliDir],
    core: true,
    async seed({ root, cfg, coreHome }) {
      project = join(root, 'project');
      mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(project, '.agent', 'tests', 'gui.tests.json'),
        `${JSON.stringify(
          {
            version: 1,
            title: 'gui',
            cases: [
              {
                id: 'gui-001',
                type: 'case',
                title: 'Вход',
                steps: [{ action: 'открыть', expected: 'открыто' }],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(project, 'README.md'), 'stand project\n');
      git(project, 'init', '-q');
      git(project, '-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'add', '.');
      git(
        project,
        '-c',
        'user.email=qa@example.com',
        '-c',
        'user.name=qa',
        'commit',
        '-qm',
        'init',
      );
      evilPath = join(project, 'src', 'evil.ts').replace(/\\/g, '/');
      // Ядро ведёт задачу дорогой входа CLI (`cli-login:claude`, набор по умолчанию новой задачи);
      // сессия ядра несёт CLAUDE_CONFIG_DIR стенда, и настоящий claude читает его settings.json:
      // адрес модели — заглушка, ключ — подставной. Настоящий аккаунт и сеть не нужны.
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: stub.baseUrl,
              ANTHROPIC_API_KEY: 'sk-ant-stand-stub',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            },
          },
          null,
          2,
        )}\n`,
      );
      void coreHome;
    },
  },
  async (stand, check) => {
    try {
      await scenario(stand, check);
    } finally {
      await stub.close();
    }
  },
);

async function scenario(stand, check) {
  {
    if (!existsSync(join(project, '.git'))) throw new NotChecked('проект стенда не собран');
    const head = git(project, 'rev-parse', 'HEAD');

    const started = await stand.api('/project-tests/run', {
      method: 'POST',
      body: { path: project, mode: 'run', groupId: 'gui' },
    });
    check('запуск прогона — 200', started.status === 200, `${started.status} ${started.text}`);

    let run;
    for (let i = 0; i < 240; i += 1) {
      const view = await stand.api(`/project-tests?path=${encodeURIComponent(project)}`);
      run = view.body?.run;
      if (run && run.status !== 'running') break;
      await wait(500);
    }
    const log = run?.log ?? '';
    check(
      'прогон кончился сам, без человека',
      Boolean(run) && run.status !== 'running',
      JSON.stringify({ status: run?.status, error: run?.error, messageCode: run?.messageCode }),
    );
    check('провайдер прогона — claude', run?.provider === 'claude', String(run?.provider));
    check('итог модели — в логе прогона', log.includes(MARK), log.slice(-1500));
    // Границы режима держит судья ядра (`session.scope`): запись вне масок отказана до диска,
    // сверке на финише ловить нечего.
    check(
      'запись вне границ отказана судьёй: файла на диске нет, строки сверки нет',
      !existsSync(join(project, 'src', 'evil.ts')) && !/тронуты файлы вне границ режима/.test(log),
      log.slice(-1500),
    );
    check('ссылка git та же', git(project, 'rev-parse', 'HEAD') === head);

    // Задача ядра: журнал в доме ядра стенда.
    const tasksDir = join(stand.coreHome, 'tasks');
    const tasks = existsSync(tasksDir) ? readdirSync(tasksDir) : [];
    const journalOf = (id) => {
      const dir = join(tasksDir, id);
      const file = readdirSync(dir).find((name) => name.endsWith('.jsonl'));
      return file ? readFileSync(join(dir, file), 'utf8') : '';
    };
    const journal = tasks.length === 1 ? journalOf(tasks[0]) : '';
    check('задача ядра одна', tasks.length === 1, tasks.join(','));
    // По `coreTaskId` вкладка «Прогоны» ведёт в задачу ядра, а снятие сироты после перезапуска
    // панели отменяет её — id в записи прогона должен быть id настоящей задачи.
    check(
      'прогон помнит id своей задачи ядра',
      tasks.length === 1 && run?.coreTaskId === tasks[0],
      JSON.stringify({ coreTaskId: run?.coreTaskId, tasks }),
    );
    const lines = journal
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const created = lines.find((line) => line.kind === 'task.created');
    const grant = lines.find((line) => line.kind === 'grant.given');
    check(
      'размещение на месте с грантом edit на корень проекта',
      created?.data?.placement === 'in-place' && JSON.stringify(grant?.data ?? {}).includes('edit'),
      JSON.stringify({ placement: created?.data?.placement, grant: grant?.data }),
    );
    const scope = created?.data?.session?.scope;
    check(
      'границы режима — в задаче ядра: маски каталога тестов и запрет git commit',
      Array.isArray(scope?.edit) &&
        scope.edit.includes('.agent/tests/**') &&
        JSON.stringify(scope.denyCommands ?? []).includes('["git","commit"]'),
      JSON.stringify(created?.data?.session ?? null),
    );
    const refusal = lines.find(
      (line) =>
        line.kind === 'decision' &&
        line.data?.class === 'permit' &&
        line.data?.output?.code === 'outside-scope',
    );
    check(
      'в журнале задачи — отказ судьи outside-scope на src/evil.ts',
      Boolean(refusal) && String(refusal.data.output.target ?? '').includes('evil.ts'),
      JSON.stringify(
        lines
          .filter((line) => line.kind === 'decision' && line.data?.class === 'permit')
          .map((line) => line.data.output),
      ).slice(0, 1500),
    );
    check(
      'запрос к модели несёт строку границ',
      stub.bodies.some((body) => body.includes('Never commit, reset or switch branches')),
      `запросов к модели: ${stub.requests.length}`,
    );
    check(
      'модель вызвана через ядро (настоящий claude на заглушке)',
      stub.requests.length > 0,
      stand.coreLog().slice(-1500),
    );
  }
}
