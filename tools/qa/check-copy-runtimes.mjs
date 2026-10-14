/**
 * Подготовка копии и стенд ревью НА НАСТОЯЩЕЙ МАШИНЕ: без подмен рантаймов и docker.
 *
 * Модульные тесты `project-git/runtimes.test.ts` и `review-stand.test.ts` дают коду
 * поддельные менеджеры версий и записывающий docker. Здесь границы настоящие:
 *
 *   1. `.nvmrc` = 22 при другой версии Node по умолчанию: подготовка копии идёт
 *      с найденным 22 впереди PATH — процесс сам печатает свою версию в лог.
 *      Нет установленного 22 на машине (nvm/fnm/volta) — шаг честно пропускается;
 *   2. `.nvmrc` = 99 (такой нет нигде): запись `missing`, подготовка не падает
 *      из-за версии, а первая настоящая ошибка выходит в `firstError`;
 *   3. Python-цепочка не строит `.venv` на неподходящей версии (`.python-version`
 *      = 2.7): венв не появляется, подготовка не провалена;
 *   4. стенд ревью: настоящий docker поднимает одноразовый контейнер из образа
 *      compose, он помечен `agentdeck.ephemeral=review`, слушает ТОЛЬКО 127.0.0.1,
 *      принимает запрос `select 1`, снимается по имени, а контейнер чужого имени
 *      `removeReviewStand` не трогает. Нет Docker или образа на машине — пропуск.
 *
 * Только временные каталоги и свой контейнер; репозитории, базы и настройки
 * человека не читаются и не меняются.
 *
 * Запуск: `node tools/qa/check-copy-runtimes.mjs` (Node 22.6+; стенд не нужен).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..', 'apps', 'server', 'src', 'domains');
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const failures = [];
let skipped = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};
const skip = (what) => {
  skipped += 1;
  console.log(`- пропуск: ${what}`);
};

const { WorktreeBootstraps, bootstrapPlanFor } = await load('project-git/bootstrap.ts');
const { realRuntimeDeps, installedNodes } = await load('project-git/runtimes.ts');
const stand = await load('chat/review-stand/review-stand.ts');
const { execDocker } = await load('compose/docker.ts');

const work = mkdtempSync(join(tmpdir(), 'cc-copy-runtimes-'));
const PRINT_VERSION = `node -p "'RAN-ON ' + process.version"`; // голый node: берётся из PATH процесса подготовки

const run = async (copy, command) => {
  const boots = new WorktreeBootstraps(join(work, 'logs'), { runtimes: realRuntimeDeps() });
  const state = await boots.run(copy, command);
  return { state, log: boots.log(copy) };
};

try {
  // 1. Нужная версия Node находится и встаёт впереди PATH.
  const deps = realRuntimeDeps();
  const has22 = installedNodes(deps).some((item) => /^22\./.test(item.text));
  const copy22 = join(work, 'copy22');
  mkdirSync(copy22);
  writeFileSync(join(copy22, '.nvmrc'), '22\n');
  if (!has22) {
    skip('на машине нет установленного Node 22 (nvm/fnm/volta) — шаг 1');
  } else {
    const { state, log } = await run(copy22, PRINT_VERSION);
    check(state.status === 'ok', `.nvmrc 22: подготовка удалась (${state.status})`);
    check(/RAN-ON v22\./.test(log), `подготовка шла на Node 22, а не на ${process.version}`);
    const note = state.runtimes?.find((item) => item.tool === 'node');
    check(
      note !== undefined && (note.status === 'switched' || note.status === 'ok'),
      `в состоянии есть строка о Node: ${note?.status}`,
    );
  }

  // 2. Версии нет нигде: не провал из-за версии, причина названа.
  const copy99 = join(work, 'copy99');
  mkdirSync(copy99);
  writeFileSync(join(copy99, '.nvmrc'), '99\n');
  const missing = await run(copy99, PRINT_VERSION);
  const missNote = missing.state.runtimes?.find((item) => item.tool === 'node');
  check(missNote?.status === 'missing', `.nvmrc 99: строка «missing» (${missNote?.status})`);
  check(missing.state.status === 'ok', 'версия не нашлась — подготовка всё равно идёт и не падает');

  // Провал команды: первая настоящая ошибка — не хвост шума.
  const noisy = join(work, 'noisy');
  mkdirSync(noisy);
  const failCommand = `node -e "console.error('npm warn deprecated x');console.error('npm error code E404');console.error('npm warn tail');process.exit(1)"`;
  const failed = await run(noisy, failCommand);
  check(failed.state.status === 'failed', 'команда с кодом 1 — «failed»');
  check(
    /E404/.test(failed.state.firstError ?? ''),
    `firstError — настоящая ошибка, не предупреждение: «${failed.state.firstError}»`,
  );
  check(
    typeof failed.state.logFile === 'string' && existsSync(failed.state.logFile),
    'полный лог лежит файлом',
  );

  // 3. Python на неподходящей версии: венв не строится.
  const py = join(work, 'py');
  mkdirSync(py);
  writeFileSync(join(py, '.python-version'), '2.7\n');
  writeFileSync(join(py, 'requirements.txt'), 'requests\n');
  writeFileSync(join(py, 'app.py'), 'print(1)\n');
  const pyPlan = bootstrapPlanFor(py);
  check(pyPlan !== undefined, 'авто-план Python-копии построен (requirements.txt)');
  const pyRun = await run(py, pyPlan);
  check(!existsSync(join(py, '.venv')), 'Python 2.7 нигде нет — .venv не построен на чужой версии');
  check(
    pyRun.state.status !== 'failed',
    `подготовка Python-копии не провалена (${pyRun.state.status})`,
  );

  // 4. Стенд ревью на настоящем docker.
  const info = await execDocker(['info', '--format', '{{.ServerVersion}}'], work, 15_000);
  const image = 'postgres:18.1-bookworm';
  const have =
    info.code === 0 && (await execDocker(['image', 'inspect', image], work, 15_000)).code === 0;
  if (!have) {
    skip(`нет Docker или образа ${image} — шаг 4`);
  } else {
    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'compose.yaml'), `services:\n  db:\n    image: ${image}\n`);
    const made = await stand.prepareReviewStand(
      { originDir: project, copyDir: project, groupKey: 'qa-runtimes' },
      {
        docker: execDocker,
        readyTries: 40,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      },
    );
    const name = made.container?.name;
    try {
      check(name !== undefined, `контейнер поднят: ${name ?? made.text.slice(0, 120)}`);
      if (name) {
        const labels = await execDocker(
          ['inspect', '--format', '{{index .Config.Labels "agentdeck.ephemeral"}}', name],
          work,
          15_000,
        );
        check(labels.stdout.trim() === 'review', 'метка agentdeck.ephemeral=review на месте');
        const ports = await execDocker(['port', name, '5432/tcp'], work, 15_000);
        check(
          /^127\.0\.0\.1:\d+/.test(ports.stdout.trim()),
          `порт открыт только на 127.0.0.1: ${ports.stdout.trim()}`,
        );
        const sql = await execDocker(
          ['exec', name, 'psql', '-U', 'postgres', '-d', 'review', '-tAc', 'select 1'],
          work,
          15_000,
        );
        check(sql.stdout.trim() === '1', 'база отвечает на select 1');
        check(
          /postgresql:\/\/postgres:[0-9a-f]+@127\.0\.0\.1:\d+\/review/.test(made.text),
          'задание содержит DSN одноразовой базы',
        );
      }
    } finally {
      if (name) {
        const foreign = await stand.removeReviewStand(execDocker, 'prod-database', work);
        check(foreign === false, 'контейнер чужого имени не снимается');
        const gone = await stand.removeReviewStand(execDocker, name, work);
        check(gone === true, 'своя база снята');
        const left = await execDocker(
          ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'],
          work,
          15_000,
        );
        check(left.stdout.trim() === '', 'после снятия контейнера нет в docker ps -a');
      }
    }
  }
} finally {
  // Каталог мог занять процесс установки — повторяем снятие, потом оставляем в temp.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Остаток в temp на результат не влияет.
  }
}

console.log(`\nпропусков: ${skipped}; провалов: ${failures.length}`);
if (failures.length > 0) {
  console.log(failures.map((item) => `  ✕ ${item}`).join('\n'));
  process.exit(1);
}
