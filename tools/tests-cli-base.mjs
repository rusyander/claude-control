/**
 * `tests-cli run --base` — прогон кейсов на развилке ветки с основной (#g0:109, 25.10).
 *
 * Ворота доставки и конца хода снимают красное «не из-за ветки», только если есть
 * чем доказать: прогон до старта группы. У кейса, которого до старта не гоняли
 * (g0: inst-api-007/014 — красные от Windows), доказать было нечем, и группа
 * стояла. Прогон на развилке — то же «до старта», снятое сейчас: содержимое,
 * которое ветка получила готовым. Отдельным модулем, как `delivery`: раннер
 * `tests-cli.mjs` правят параллельно.
 *
 * Как: временное дерево `git worktree add --detach` на развилке, в него — кейсы
 * копии (`.agent/tests/*.json`, без истории), там обычный `run --fresh`, его
 * запись — в `.agent/tests/runs-base/` копии с `commit` = развилка. Историю копии
 * прогон не трогает: это довод о чужом коде, не результат ветки. Из зависимостей
 * копии в дерево идут только `node_modules` пакетов, чей package.json и lock-файл
 * на развилке те же (`mirrorNodeModules`); venv и прочие — нет, красное там с другой
 * подписью кейс не снимает (`redNotFromBranch`). Гоняются только красные тесты последнего
 * прогона ветки, где раннер умеет выбрать тест (`red-filter`, F-03), иначе кейс целиком.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Модуль сервера по пути от корня репозитория панели. */
async function serverModule(repo, ...path) {
  return await import(pathToFileURL(join(repo, 'apps', 'server', 'src', ...path)).href);
}

/** Флаги, которые дочерний прогон получает свои, — остальные идут ему как есть. */
const OWN_FLAGS = new Set(['--base', '--memo', '--fresh']);

/**
 * Корень исходной копии — дочернему прогону развилки: `{copy}` в `--cmd` раскрывается в
 * него, а не в дерево развилки (g0 26.10: venv копии в `.agent/tmp` относительным путём
 * в дереве развилки не нашёлся, прогон упал за 0 с и был повторён с абсолютным).
 */
export const BASE_COPY_ENV = 'AGENTDECK_TESTS_BASE_COPY';

/** Относительный путь в строке команды: от начала, пробела или разделителя списка путей. */
const RELATIVE_PATH = /(^|[\s;:=,"'(])(\.?[\w-][\w.-]*(?:[\\/][\w.-]+)+)/g;

/**
 * Относительные пути `--cmd`, которые есть только в копии вне git (`.agent/tmp`, venv), — в
 * путь копии до прогона. Подсказка про `{copy}` приходила лишь после провала: g0 27.10 01:42
 * снова потратила прогон на `PYTHONPATH=.agent/tmp/pyshim`. Путь из дерева развилки и файл
 * ветки под git не трогаются: первый — код основной, второй развилке не принадлежит.
 */
export function expandCopyPaths(line, copy, tree) {
  const expanded = [];
  const out = line.replace(RELATIVE_PATH, (whole, lead, path) => {
    if (existsSync(join(tree, path)) || !existsSync(join(copy, path))) return whole;
    const tracked = spawnSync('git', ['ls-files', '--', path], { cwd: copy, encoding: 'utf8' });
    if (tracked.status !== 0 || tracked.stdout.trim()) return whole;
    expanded.push(path);
    const full = join(copy, path);
    // Путь копии с пробелом — отдельным словом в кавычках, иначе оболочка его разрежет; внутри
    // значения (`X=…`, список через `;`/`:`) и в уже открытых кавычках он остаётся как есть.
    const word = lead === '' || /[\s(,]/.test(lead);
    return lead + (word && /\s/.test(full) ? `"${full}"` : full);
  });
  return { line: out, expanded };
}

/** Аргументы этого вызова без `--project <dir>` и флагов, которые задаёт сам `--base`. */
export function childArgs(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project') {
      index += 1;
      continue;
    }
    if (!OWN_FLAGS.has(argv[index])) out.push(argv[index]);
  }
  return out;
}

/**
 * Файлы окружения Go, которых нет в git, — из копии в дерево развилки. У монорепозитория на Go
 * `go.sum` в `.gitignore`: копия получает его при подготовке, дерево развилки — нет,
 * и `go test` там падал сборкой «missing go.sum entry» до первого теста (g0 25.10,
 * 20:13) — довод о Windows-красных был недостижим ни для одного Go-кейса. Только
 * они: версии задаёт `go.mod` развилки, `go.sum` несёт лишь хэши. venv и `dist` не
 * берутся: в них код ветки (editable-установки, сборки), и красное развилки с ними
 * снимало бы с ветки то, что сломала она. `node_modules` — отдельно и с проверкой,
 * `mirrorNodeModules`.
 */
export function mirrorGoEnv(project, tree) {
  // Модули — по индексу git (быстро: без обхода игнорируемых node_modules); у
  // отслеживаемого на развилке go.sum файл в дереве уже есть и не трогается.
  const listed =
    spawnSync('git', ['ls-files', '-z', '--', ':(glob)**/go.mod'], {
      cwd: project,
      encoding: 'utf8',
    }).stdout ?? '';
  const modules = listed
    .split('\0')
    .filter(Boolean)
    .map((file) => posix.dirname(file));
  const wanted = [
    ...modules.map((dir) => (dir === '.' ? 'go.sum' : `${dir}/go.sum`)),
    'go.work',
    'go.work.sum',
  ];
  const copied = [];
  for (const rel of wanted) {
    const from = join(project, rel);
    const to = join(tree, rel);
    // Модуля на развилке нет (ветка его завела) — его go.sum там не нужен.
    if (!existsSync(from) || existsSync(to) || !existsSync(dirname(to))) continue;
    copyFileSync(from, to);
    copied.push(rel);
  }
  return copied;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

/** Файл одинаков в копии и дереве: оба есть с теми же байтами или обоих нет. */
function sameFile(project, tree, rel) {
  const a = join(project, rel);
  const b = join(tree, rel);
  if (!existsSync(a) || !existsSync(b)) return existsSync(a) === existsSync(b);
  return readFileSync(a).equals(readFileSync(b));
}

/** Ссылка в node_modules ведёт наружу — пакет рабочего пространства, то есть код ветки. */
function outsideLink(modules) {
  const root = realpathSync(modules);
  const entries = readdirSync(modules).flatMap((name) =>
    name.startsWith('@') && lstatSync(join(modules, name)).isDirectory()
      ? readdirSync(join(modules, name)).map((inner) => `${name}/${inner}`)
      : [name],
  );
  for (const name of entries) {
    const path = join(modules, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    let target;
    try {
      target = realpathSync(path);
    } catch {
      continue;
    }
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return name;
  }
  return undefined;
}

/**
 * `node_modules` копии — в дерево развилки ссылкой (M3, g5 27.10: e2e `--base` падал
 * «Playwright не установлен», группа ставила зависимости в копии, «up to date», и падала
 * снова — дерево развилки зависимостей не имело вовсе). Берётся только там, где они
 * заведомо развилки тоже: package.json пакета и lock-файлы (пакета и корня) побайтно те
 * же, в дереве своего node_modules нет, и ни одна ссылка верхнего уровня не ведёт наружу —
 * такая ссылка значит пакет рабочего пространства, код ветки. Ссылка — junction (Windows
 * без прав администратора), её снимают ДО `git worktree remove`: удаление дерева иначе
 * прошло бы сквозь неё по зависимостям копии.
 */
export function mirrorNodeModules(project, tree) {
  const listed =
    spawnSync('git', ['ls-files', '-z', '--', 'package.json', ':(glob)**/package.json'], {
      cwd: project,
      encoding: 'utf8',
    }).stdout ?? '';
  const dirs = [
    ...new Set(
      listed
        .split('\0')
        .filter((file) => file && !file.split('/').includes('node_modules'))
        .map((file) => posix.dirname(file)),
    ),
  ].sort();
  const linked = [];
  const skipped = [];
  const rootLocks = LOCKFILES.filter((name) => !sameFile(project, tree, name));
  for (const dir of dirs) {
    const rel = dir === '.' ? '' : dir;
    const from = join(project, rel, 'node_modules');
    const to = join(tree, rel, 'node_modules');
    const shown = dir === '.' ? '.' : dir;
    if (!existsSync(from)) continue;
    if (!existsSync(join(tree, rel, 'package.json'))) {
      skipped.push(`${shown} — пакета на развилке нет`);
      continue;
    }
    if (existsSync(to)) continue;
    if (!sameFile(project, tree, posix.join(rel, 'package.json'))) {
      skipped.push(`${shown} — package.json не тот, что на развилке`);
      continue;
    }
    const locks = [
      ...rootLocks,
      ...(rel ? LOCKFILES.filter((name) => !sameFile(project, tree, posix.join(rel, name))) : []),
    ];
    if (locks.length) {
      skipped.push(`${shown} — lock-файл не тот, что на развилке (${locks.join(', ')})`);
      continue;
    }
    const outside = outsideLink(from);
    if (outside) {
      skipped.push(`${shown} — ${outside} ссылается на пакет рабочего пространства (код ветки)`);
      continue;
    }
    symlinkSync(from, to, 'junction');
    linked.push({ dir: shown, link: to });
  }
  return { linked, skipped };
}

/**
 * Снять ссылки node_modules до удаления дерева. Не снялась — дерево не удаляется: сквозь
 * ссылку ушли бы зависимости копии.
 */
export function unlinkNodeModules(linked) {
  const stuck = [];
  for (const { link } of linked) {
    try {
      unlinkSync(link);
    } catch {
      try {
        rmSync(link);
      } catch {
        if (existsSync(link)) stuck.push(link);
      }
    }
  }
  return stuck;
}

/** Первая строка заметки — что увидит человек рядом с вердиктом. */
const headOf = (result) =>
  (result?.note ?? result?.failure?.actual ?? '').split('\n')[0].slice(0, 160);

/**
 * Вердикт по кейсу развилки против последнего результата ветки — тем же правилом
 * подписи, что у ворот (`redSignature`): «Ворота снимают красное с той же подписью»
 * без ответа, та ли она, группа читала как «доказано» (g0 25.10: развилка не
 * собралась, а группа пошла дальше).
 */
export function forkVerdicts(baseResults, branchRuns, redSignature) {
  const lines = [];
  for (const item of baseResults) {
    const key = `${item.groupId}:${item.caseId}`;
    const branch = branchRuns
      .flatMap((run) => run.results)
      .find((result) => result.groupId === item.groupId && result.caseId === item.caseId);
    const red = (result) => result.status === 'failed' || result.status === 'blocked';
    if (!red(item)) {
      lines.push(`  ${key} — зелёный на развилке: красное ветки — её`);
    } else if (!branch || !red(branch)) {
      lines.push(`  ${key} — красный на развилке, у ветки красного нет`);
    } else if (redSignature(item) && redSignature(item) === redSignature(branch)) {
      lines.push(`  ${key} — та же подпись, что у ветки: ворота снимут его с ветки`);
    } else {
      lines.push(
        `  ${key} — подпись не та, что у ветки: это не довод, ворота его не снимут` +
          ` (развилка: «${headOf(item)}»; ветка: «${headOf(branch)}»)`,
      );
    }
  }
  return lines;
}

export async function runOnBase(project, { repo, self, argv }) {
  const { mainForkOf } = await serverModule(
    repo,
    'domains',
    'project-git',
    'sieve-facts',
    'sieve-facts.ts',
  );
  const { readRuns, writeBaseRun } = await serverModule(
    repo,
    'domains',
    'project-tests',
    'runs-store',
    'runs-store.ts',
  );
  const fork = await mainForkOf(project);
  if (!fork.base)
    throw new Error(
      'Развилки с основной нет: у копии нет remote или ссылки основной (origin/HEAD, origin/main, origin/master).',
    );
  const tests = join(project, '.agent', 'tests');
  if (!existsSync(tests)) throw new Error(`Кейсов нет: ${tests}`);
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-base-'));
  const tree = join(temp, 'tree');
  const added = spawnSync('git', ['worktree', 'add', '--detach', tree, fork.base], {
    cwd: project,
    encoding: 'utf8',
  });
  if (added.status !== 0) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(`git worktree add на развилке не вышел: ${(added.stderr ?? '').trim()}`);
  }
  let modules = { linked: [], skipped: [] };
  try {
    const into = join(tree, '.agent', 'tests');
    mkdirSync(into, { recursive: true });
    for (const name of readdirSync(tests))
      if (name.endsWith('.json')) copyFileSync(join(tests, name), join(into, name));
    console.log(`Развилка с ${fork.mainRef}: ${fork.base.slice(0, 12)} — дерево ${tree}`);
    const env = mirrorGoEnv(project, tree);
    if (env.length)
      console.log(
        `Из копии — файлы окружения Go, которых нет в git: ${env.slice(0, 6).join(', ')}` +
          (env.length > 6 ? ` (+${env.length - 6})` : ''),
      );
    modules = mirrorNodeModules(project, tree);
    if (modules.linked.length || modules.skipped.length)
      console.log(
        `node_modules копии: связаны ${modules.linked.map((item) => item.dir).join(', ') || '—'}` +
          (modules.skipped.length ? `; не взяты: ${modules.skipped.join('; ')}` : ''),
      );
    // Красные тесты ветки — дочернему прогону: он гоняет только их, где раннер умеет
    // выбрать тест (F-03: 2105 тестов pytest ради одного красного).
    const { BASE_RED_ENV, branchRedTests } = await serverModule(
      repo,
      'domains',
      'project-tests',
      'red-filter',
      'red-filter.ts',
    );
    const reds = join(temp, 'branch-red.json');
    writeFileSync(reds, JSON.stringify(branchRedTests(readRuns(project, 50))));
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, self, ...childArgs(argv), '--project', tree, '--fresh'],
      {
        cwd: tree,
        stdio: 'inherit',
        env: { ...process.env, [BASE_RED_ENV]: reds, [BASE_COPY_ENV]: project },
      },
    );
    const [run] = readRuns(tree, 1);
    if (!run) {
      console.log('\nПрогон на развилке не записан — доказательства нет, блок копии не тронут.');
      process.exitCode = child.status || 1;
      return;
    }
    // Отпечатки — про содержимое развилки: свежесть прогонов ветки по ним не судят.
    const record = { ...run };
    delete record.stamps;
    writeBaseRun(project, {
      ...record,
      commit: fork.base,
      ...(fork.mainRef ? { branch: fork.mainRef } : {}),
      scope: `развилка ${fork.base.slice(0, 12)}: ${run.scope ?? ''}`.trim(),
    });
    const red = run.results.filter((item) => item.status === 'failed' || item.status === 'blocked');
    console.log(
      `\nПрогон на развилке записан (${run.id}): кейсов ${run.results.length}, красных ${red.length}` +
        (red.length ? ` — ${red.map((item) => `${item.groupId}:${item.caseId}`).join(', ')}` : '') +
        '. Ворота доставки снимают с ветки красное с той же подписью; зелёное здесь — красное ветки её.',
    );
    const { redSignature } = await serverModule(
      repo,
      'domains',
      'chat',
      'tests-gate',
      'tests-gate.ts',
    );
    for (const line of forkVerdicts(run.results, readRuns(project, 50), redSignature))
      console.log(line);
  } finally {
    const stuck = unlinkNodeModules(modules.linked);
    if (stuck.length) {
      // Сквозь неснятую ссылку удаление дерева ушло бы в зависимости копии.
      console.log(
        `Ссылки node_modules не снялись (${stuck.join(', ')}) — дерево ${tree} оставлено; ` +
          'снимите ссылки и выполните git worktree remove --force вручную.',
      );
    } else {
      const removed = spawnSync('git', ['worktree', 'remove', '--force', tree], {
        cwd: project,
      });
      if (removed.status !== 0) spawnSync('git', ['worktree', 'prune'], { cwd: project });
      rmSync(temp, { recursive: true, force: true });
    }
  }
}
