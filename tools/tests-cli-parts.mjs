/**
 * `tests-cli run` — что кейсы несут с собой помимо файла автотеста (аудит 27.10, M2/M3/F2/F3).
 *
 * - окружение набора (`env` в `.agent/tests/automation.json`) и своя команда кейса у копии
 *   (`.agent/tests/case-commands.json`, `case-cmd`): кейсы с разным окружением или командой
 *   идут частями — отдельным `run` на часть, одна переменная на весь прогон годится не всем;
 * - адрес стенда раннера для `--health` (Playwright: переменная, иначе значение конфига);
 * - отчёты ворот на том же дереве (`.agent/tests/gate-junit/`) — `run --stale` их забирает.
 *
 * Отдельным модулем, как `delivery` и `--base`: раннер `tests-cli.mjs` правят параллельно.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE_COPY_ENV } from './tests-cli-base.mjs';

/** Модуль домена тестов по имени (`имя/имя.ts`). */
async function testsModule(repo, name) {
  return await import(
    pathToFileURL(
      join(repo, 'apps', 'server', 'src', 'domains', 'project-tests', name, `${name}.ts`),
    ).href
  );
}

/** Код выхода прогона, не начатого без стенда, и прогона, упавшего на окружении: повторить позже. */
export const ENVIRONMENT_EXIT = 75;

/**
 * Части прогона: кейсы с одной командой (своя у копии или общая) и одним окружением набора.
 * Явный `--cmd` сильнее своей команды кейса — он назван в этой самой команде.
 */
export async function runParts(repo, project, automated, options) {
  const { readSuiteEnv, suiteEnvFor } = await testsModule(repo, 'suite-env');
  const { readCaseCommands } = await testsModule(repo, 'case-commands');
  const env = readSuiteEnv(project);
  if (env.error) throw new Error(`.agent/tests/automation.json: ${env.error}`);
  const own = options.cmd ? { commands: {} } : readCaseCommands(project);
  if (own.error) throw new Error(own.error);
  // `{copy}` в значении — исходная копия и на развилке: файлы вне git лежат там.
  const copy = process.env[BASE_COPY_ENV] || project;
  const parts = new Map();
  for (const { group, item } of automated) {
    const key = `${group}:${item.id}`;
    const { vars, from } = suiteEnvFor(env.entries, item.automation.file, copy);
    const command = own.commands[key];
    const id = JSON.stringify([
      command?.cmd ?? null,
      command?.format ?? null,
      Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const part = parts.get(id) ?? {
      id,
      ...(command
        ? { cmd: command.cmd, ...(command.format ? { format: command.format } : {}) }
        : {}),
      env: vars,
      from: new Set(),
      keys: [],
    };
    part.keys.push(key);
    for (const dir of from) part.from.add(dir);
    parts.set(id, part);
  }
  return [...parts.values()];
}

/** Чем часть отличается — в заголовок части и в строку прогона. */
export function partSaid(part) {
  const said = [];
  if (part.cmd) said.push(`своя команда копии: ${part.cmd}`);
  const names = Object.keys(part.env);
  if (names.length)
    said.push(
      `окружение набора ${names.join(', ')} (automation.json «env»: ${[...part.from].join(', ')})`,
    );
  return said.join('; ');
}

/** Аргументы вызова без выбора кейсов и проекта: часть получает их своими. */
function partArgs(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--case' || argv[index] === '--project') {
      index += 1;
      continue;
    }
    if (argv[index] !== '--stale') out.push(argv[index]);
  }
  return out;
}

/** Код всего прогона частями: красное сильнее предела, предел — сильнее «нет стенда». */
export function worstCode(codes) {
  for (const code of [1, 124, ENVIRONMENT_EXIT]) if (codes.includes(code)) return code;
  return codes.find((code) => code !== 0) ?? 0;
}

/** Части — по очереди, каждая своим `run`: своя запись истории, своё окружение, свой код. */
export function runPartsApart(project, parts, { argv, self }) {
  console.log(
    `Кейсы идут частями (${parts.length}): у них разная своя команда или окружение набора.`,
  );
  const base = partArgs(argv);
  const codes = parts.map((part, index) => {
    const said = partSaid(part);
    console.log(
      `\n── Часть ${index + 1} из ${parts.length}: ${part.keys.join(',')}${said ? ` — ${said}` : ''}`,
    );
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, self, ...base, '--case', part.keys.join(','), '--project', project],
      { stdio: 'inherit', env: process.env },
    );
    return child.status ?? 1;
  });
  const code = worstCode(codes);
  console.log(`\nЧасти: ${codes.map((item, index) => `${index + 1} — код ${item}`).join(', ')}.`);
  return code;
}

/**
 * Адреса для `--health`: без адреса — куда ходит раннер (Playwright: переменная окружения,
 * иначе значение по умолчанию из конфига); с адресом — он, если раннер ходит туда же, иначе
 * отказ с обоими адресами. Раннер без известного адреса — названный адрес как есть.
 */
export async function healthUrls(repo, plan, health, env) {
  const { standTargets, sameStand } = await testsModule(repo, 'runner-target');
  const found = (plan.playwright ?? []).map(({ cwd, files }) => standTargets(cwd, files, env));
  const targets = found.flatMap((item) => item.urls);
  const shown = targets.map(({ url, from }) => `${url} (${from})`).join(', ');
  const configs = found.map((item) => item.config).filter(Boolean);
  if (health === true) {
    if (found.some((item) => item.webServer))
      throw new Error(
        `Стенд поднимает сам Playwright (webServer в ${configs.join(', ')}): до прогона его нет — --health здесь не нужен.`,
      );
    if (targets.length === 0) {
      const unresolved = found.flatMap((item) => item.unresolved);
      throw new Error(
        unresolved.length
          ? `Адрес стенда раннера не найден: ${unresolved.join('; ')}. Задайте переменную или назовите --health <url>.`
          : 'Адреса стенда у раннера этих кейсов нет (его знает только Playwright с baseURL в конфиге) — назовите --health <url>.',
      );
    }
    return { urls: [...new Set(targets.map(({ url }) => url))], said: shown };
  }
  try {
    new URL(health);
  } catch {
    throw new Error(`--health ждёт адрес стенда (http://… или https://…), а получил «${health}».`);
  }
  if (targets.length && !targets.some(({ url }) => sameStand(url, health)))
    throw new Error(
      `--health ${health} — не тот стенд: раннер этих кейсов ходит на ${shown} (${configs.join(', ')}). ` +
        'Назовите его адрес или дайте --health без адреса — он возьмётся сам.',
    );
  return { urls: [health], said: health };
}

/**
 * `run --stale`: отчёты ворот в `.agent/tests/gate-junit/` со своим отпечатком дерева. Тот же,
 * что у дерева сейчас, — в историю без прогона; другой или нет — назван и оставлен.
 */
export async function takeGateReports(repo, project, keys) {
  const { gateReports, dropGateReport } = await testsModule(repo, 'gate-junit');
  const reports = gateReports(project);
  if (reports.length === 0) return 0;
  const { treeFingerprint } = await testsModule(repo, 'check-memo');
  const { importResults } = await testsModule(repo, 'import-results');
  const { contentStamps, stampInputs } = await testsModule(repo, 'content-stamp');
  const { readGroups } = await testsModule(repo, 'store');
  const { blockEnvironmentFailures } = await testsModule(repo, 'env-failure');
  const tree = treeFingerprint(project);
  let taken = 0;
  for (const report of reports) {
    if (!tree || report.tree !== tree) {
      console.log(
        `Отчёт ворот ${report.name}: ${report.tree ? 'снят на другом дереве' : `без отпечатка дерева (${report.name}.tree)`} — ` +
          'не засчитан, его кейсы идут прогоном.',
      );
      continue;
    }
    const verdict = blockEnvironmentFailures(
      readFileSync(report.xml, 'utf8'),
      goSumTracked(project),
    );
    const imported = importResults(project, {
      format: 'junit',
      content: verdict.content,
      origin: 'ci',
      scope: `ворота ${report.name} на этом же дереве (tests-cli run --stale)`,
      exitCode: verdict.red ? 1 : 0,
      stamps: contentStamps(project, stampInputs(readGroups(project), new Set(keys))),
      tree,
    });
    dropGateReport(report);
    taken += imported.matched;
    console.log(
      `Отчёт ворот ${report.name} снят на этом же дереве — засчитан без прогона: тестов ${imported.read}, ` +
        `кейсов ${imported.matched}, запись ${imported.runId ?? '—'}.`,
    );
  }
  return taken;
}

/** `go.sum` под git хоть у одного модуля — его недостающая запись дефект ветки, не окружения. */
export function goSumTracked(project) {
  const listed = spawnSync('git', ['ls-files', '--', ':(glob)**/go.sum'], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
  });
  return listed.status === 0 && listed.stdout.trim() !== '';
}

/** `tests-cli tree [--out <файл>]` — отпечаток дерева для `<имя>.tree` рядом с отчётом ворот. */
export async function printTree(repo, project, options) {
  const { treeFingerprint } = await testsModule(repo, 'check-memo');
  const tree = treeFingerprint(project);
  if (!tree)
    throw new Error(
      'Отпечаток дерева не снят: каталог не под git, в нём вложенный репозиторий или слишком много неотслеживаемых файлов.',
    );
  if (typeof options.out !== 'string') return console.log(tree);
  const out = resolve(project, options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${tree}\n`);
  console.log(`Отпечаток дерева записан: ${out}`);
}

/**
 * `tests-cli case-cmd` — своя команда кейсов у копии: без ключей — список; `<ключи> --cmd`
 * — задать; `<ключи> --clear` — снять. Ключи — как у `run --case`.
 */
export async function caseCommand(repo, project, options, keys) {
  const { readCaseCommands, saveCaseCommands, commandIssue, CASE_COMMANDS_FILE } =
    await testsModule(repo, 'case-commands');
  const where = `.agent/tests/${CASE_COMMANDS_FILE}`;
  if (keys === undefined) {
    const { commands, error } = readCaseCommands(project);
    if (error) throw new Error(error);
    const entries = Object.entries(commands);
    if (entries.length === 0) return console.log(`Своих команд кейсов у копии нет (${where}).`);
    console.log(`Свои команды кейсов копии (${where}):`);
    for (const [key, item] of entries)
      console.log(`  ${key} — ${item.cmd}${item.format ? ` (--format ${item.format})` : ''}`);
    return;
  }
  if (options.clear) {
    saveCaseCommands(project, keys, undefined);
    return console.log(`Своя команда снята: ${keys.join(', ')}. Дальше — общая команда прогона.`);
  }
  if (typeof options.cmd !== 'string')
    throw new Error('case-cmd <группа:кейс,…> --cmd "<команда>" — задать; --clear — снять.');
  const issue = commandIssue(options.cmd);
  if (issue) throw new Error(issue);
  const outcome = saveCaseCommands(project, keys, {
    cmd: options.cmd,
    ...(typeof options.format === 'string' ? { format: options.format } : {}),
    at: new Date().toISOString(),
  });
  console.log(
    `Своя команда задана (${keys.join(', ')}): ${options.cmd}\n` +
      `Лежит в ${where} — вне git (${outcome === 'excluded' ? 'путь дописан в info/exclude' : outcome === 'ignored' ? 'уже игнорируется' : 'каталог не под git'}). ` +
      'Её берут run, run --stale и run --base, пока в самой команде не назван --cmd.',
  );
}
