#!/usr/bin/env node
/**
 * КЛЮЧ ДОХОДИТ ДО ПРОЦЕССА — И БОЛЬШЕ НИКУДА (П3.5).
 *
 * Здесь не подменяется ничего, кроме самого CLI: на PATH кладётся поддельный
 * `qwen`, который СБРАСЫВАЕТ СВОЁ ОКРУЖЕНИЕ в файл и выходит. Запуск идёт
 * настоящим `spawnCliProcess` — тем же, которым панель запускает чужой CLI, — и
 * значение-маркер разыскивается всюду, где его быть не должно: в файлах цели, в
 * резервных копиях `<appData>/backups`, в `state.json`, в шифрованном хранилище
 * и в строках отчёта. Встретиться оно обязано ровно в одном месте — в окружении
 * запущенного процесса.
 *
 * Таблицы собранных руками вызовов здесь нет намеренно: они доказывали бы
 * таблицу (это делают юниты `supervisor/env-inject.test.ts`), а не то, что ключ
 * пережил дорогу до процесса и не осел по пути. На Windows дорога идёт через
 * `.cmd`-обёртку и `cmd.exe` — то самое место, где окружение уже однажды теряли.
 *
 * Обратная сторона проверяется тем же прогоном: ключа в хранилище нет — в
 * окружении не появляется ни ключа, ни ПУСТОЙ СТРОКИ вместо него; выключенная
 * группа своих переменных не подмешивает.
 *
 * Запуск: node tools/qa/check-portability-secrets.mjs
 * Самопроверка: node tools/qa/check-portability-secrets.mjs --selftest — тикет
 * требует именно её: намеренно включает запись ключа в файл цели (та самая
 * галочка) и ждёт красного, второй порчей подставляет пустую строку вместо
 * отсутствующего ключа. Проверка, которая не может покраснеть, — украшение.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const SELFTEST = process.argv.includes('--selftest');
const isWindows = process.platform === 'win32';

/**
 * Значения-маркеры. Собраны из кусков: в репозитории не должно лежать
 * присваивание, похожее на настоящий ключ.
 */
const MARKER = ['portability', 'marker', 'secret', '7e41'].join('-');
const GROUP_OFF_MARKER = ['group', 'off', 'marker', '3b90'].join('-');

/** Цель: у `qwen` задокументированы и `.env`, и имена переменных ключа. */
const FOREIGN = 'qwen';
/** Переменная ключа — из объявленных провайдером (`assistant.apiKeyEnvVars`). */
const KEY_VAR = 'OPENAI_API_KEY';
const DUMP = 'cc-secret-env-dump.txt';

let dirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  dirs = [];
}

/** Поддельный CLI под этим именем: печатает своё окружение в рабочую папку прогона. */
function fakeCli(bin, name) {
  if (isWindows) {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\nset > "%CD%\\${DUMP}"\r\nexit /b 0\r\n`);
    return;
  }
  writeFileSync(join(bin, name), `#!/bin/sh\nenv > "$PWD/${DUMP}"\nexit 0\n`, { mode: 0o755 });
}

/** Окружение, которое напечатал поддельный CLI, разобранное в карту. */
function dumpOf(dir) {
  const path = join(dir, DUMP);
  if (!existsSync(path)) return undefined;
  // latin1: `set` на Windows печатает в кодовой странице консоли, а маркеры и
  // имена переменных — ASCII, и байты не должны переехать в «крокозябры».
  const raw = readFileSync(path, 'latin1');
  const env = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
  }
  return { raw, env };
}

async function waitForDump(dir, seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const dump = dumpOf(dir);
    if (dump) return dump;
    await wait(250);
  }
  return undefined;
}

/** Все файлы дерева — обход для розыска маркера. */
function filesOf(root, skip = new Set()) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const name of readdirSync(root)) {
    if (skip.has(name)) continue;
    const path = join(root, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...filesOf(path, skip));
    else found.push(path);
  }
  return found;
}

/**
 * Есть ли маркер в файле. Читается как БАЙТЫ: искать текстом значило бы пропустить
 * ключ, осевший в не-utf8 файле, — а вопрос тикета именно «лежит ли он на диске».
 */
function fileHasMarker(path) {
  try {
    return readFileSync(path).includes(MARKER);
  } catch {
    return false;
  }
}

/** Группа панели: одна включённая, одна выключенная — их и различает прогон. */
function groupOf(id, isEnabled, env, order) {
  return {
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env,
    isEnabled,
    order,
  };
}

/**
 * Один прогон по-настоящему. `damage` — порча, которой пользуется только
 * самопроверка: `write-to-file` включает галочку «записать ключ в файл цели»,
 * `empty-secret` подставляет пустую строку вместо отсутствующего ключа.
 *
 * `fatal` отделяет сломанную обстановку (цель не нашлась, процесс не запустился)
 * от найденного нарушения: иначе самопроверка приняла бы поломку стенда за
 * пойманную порчу и позеленела бы молча.
 */
async function probe(damage) {
  const problems = [];
  const fatal = (text) => ({ problems: [...problems, text], fatal: true });

  const appData = tempDir('portability-secrets-appdata-');
  const home = tempDir('portability-secrets-home-');
  const bin = tempDir('portability-secrets-bin-');
  const workdir = tempDir('portability-secrets-work-');
  const gapWorkdir = tempDir('portability-secrets-gap-');
  const emptyStore = tempDir('portability-secrets-nostore-');
  const backupDir = join(appData, 'backups');
  mkdirSync(backupDir, { recursive: true });

  // Каталог цели подменяется ДО первого импорта серверного кода: путь к `.env`
  // провайдер считает при вызове, и подменённый дом обязан быть виден первому же.
  const qwenHome = join(home, '.qwen');
  process.env.QWEN_HOME = qwenHome;
  mkdirSync(qwenHome, { recursive: true });
  // Ключ из окружения самой машины ребёнок унаследовал бы и без панели — тогда
  // «панель ничего не подставила» стало бы неотличимо от «подставила».
  delete process.env[KEY_VAR];

  const { AppStore } = await import('../../apps/server/src/lib/app-store.ts');
  const { setStoredKey } = await import('../../apps/server/src/lib/provider-keys.ts');
  const { spawnCliProcess } = await import('../../apps/server/src/lib/cli-spawn.ts');
  const { resolveProviderEnvTargetFor, saveProviderEnvVars } =
    await import('../../apps/server/src/domains/provider-env.ts');
  const { CATALOG_PROVIDERS } = await import('../../apps/server/src/providers/catalog.ts');
  const { buildPortableEnv, describePortableEnv, planSecretFileWrite } =
    await import('../../apps/server/src/domains/portability/supervisor/env-inject.ts');

  const provider = CATALOG_PROVIDERS.find((candidate) => candidate.id === FOREIGN);
  if (!provider) return fatal(`в каталоге нет цели ${FOREIGN}`);

  fakeCli(bin, FOREIGN);
  process.env.PATH = `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`;

  // ── Состояние панели: ключ в шифрованном хранилище, группы в state.json ─────
  setStoredKey(appData, FOREIGN, MARKER);
  const groups = [
    groupOf('on', true, { CC_GROUP_ON: 'on-value' }, 1),
    groupOf('off', false, { CC_GROUP_OFF: GROUP_OFF_MARKER }, 2),
  ];
  new AppStore(appData).updateSettings({ groups });

  // ── Канон среды цели: имя переменной со значением и ФАКТ наличия ключа ──────
  const source = {
    provider: FOREIGN,
    scope: 'global',
    origin: 'file',
    file: join(qwenHome, '.env'),
    plugin: null,
  };
  const base = {
    source,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: { resolution: 'none', why: 'переменная действует постоянно' },
  };
  const items = [
    {
      ...base,
      id: 'envVar:CC_CANON_VAR',
      kind: 'envVar',
      intent: 'переменная окружения CC_CANON_VAR',
      sideEffects: [],
      name: 'CC_CANON_VAR',
      value: 'canon-value',
      raw: 'CC_CANON_VAR=canon-value',
    },
    {
      ...base,
      id: `secret:${KEY_VAR}`,
      kind: 'secret',
      intent: `ключ ${KEY_VAR}`,
      sideEffects: ['reads_secrets'],
      name: KEY_VAR,
      mask: 'por…7e41',
      holder: 'panel',
    },
  ];

  const request = { provider, appDataDir: appData, items, groups };
  const injection = buildPortableEnv(request);
  const report = describePortableEnv(injection).join('\n');

  // ── Файл цели пишется НАСТОЯЩИМ писателем раздела env ───────────────────────
  // Имена переменных в файл ложатся, значение ключа — нет. Файл создаётся заранее
  // непустым, а запись идёт дважды, чтобы появились резервные копии: копия — такое
  // же место, где ключа быть не должно.
  const target = resolveProviderEnvTargetFor(provider);
  if (!target) return fatal(`у цели ${FOREIGN} нет раздела переменных окружения`);
  writeFileSync(target.filePath, 'CC_HUMAN_VAR=человек\n', 'utf8');
  const fileVars = [
    { key: 'CC_HUMAN_VAR', value: 'человек' },
    { key: 'CC_CANON_VAR', value: 'canon-value' },
  ];
  // Порча самопроверки: галочка «записать ключ в файл цели» включена, и в файл
  // уходит настоящее значение — ровно тот случай, который обязан покраснеть.
  const plan = planSecretFileWrite(request, damage === 'write-to-file');
  for (const item of plan.vars) fileVars.push({ key: item.key, value: item.value });
  saveProviderEnvVars(target, fileVars, backupDir);
  saveProviderEnvVars(target, [...fileVars, { key: 'CC_SECOND_PASS', value: '2' }], backupDir);

  // ── Настоящий запуск: поддельный CLI сбрасывает своё окружение ──────────────
  const spawned = spawnCliProcess(FOREIGN, ['-p', 'привет'], {
    cwd: workdir,
    portableEnv: () => injection.env,
  });
  if (spawned.error) return fatal(`запуск не состоялся: ${spawned.error.message}`);
  const dump = await waitForDump(workdir);
  if (!dump) return fatal('поддельный CLI не запустился или не выгрузил своё окружение');

  // 1. Ключ обязан быть в окружении процесса — ровно там он и нужен.
  if (dump.env.get(KEY_VAR) !== MARKER) {
    problems.push(`ключ до процесса не дошёл: ${KEY_VAR}=${dump.env.get(KEY_VAR) ?? '—'}`);
  }
  // 2. Имя переменной канона доезжает, и окружение остаётся ДОБАВКОЙ.
  if (dump.env.get('CC_CANON_VAR') !== 'canon-value') {
    problems.push(`переменная канона до процесса не дошла: ${dump.env.get('CC_CANON_VAR') ?? '—'}`);
  }
  if (!dump.env.has('PATH') && !dump.env.has('Path')) {
    problems.push('PATH процесса пропал: окружение заменено, а не дополнено');
  }
  // 3. Группы: включённая подмешала, выключенная промолчала.
  if (dump.env.get('CC_GROUP_ON') !== 'on-value') {
    problems.push(`переменная включённой группы не дошла: ${dump.env.get('CC_GROUP_ON') ?? '—'}`);
  }
  if (dump.env.has('CC_GROUP_OFF') || dump.raw.includes(GROUP_OFF_MARKER)) {
    problems.push('выключенная группа подмешала свою переменную в окружение процесса');
  }

  // ── Второй прогон: ключа в хранилище нет ───────────────────────────────────
  const gap = buildPortableEnv({ ...request, appDataDir: emptyStore });
  if (!gap.missing.some((item) => item.name === KEY_VAR && item.gap === 'not_in_store')) {
    problems.push(`отсутствие ключа не названо до запуска: ${JSON.stringify(gap.missing)}`);
  }
  const gapSpawn = spawnCliProcess(FOREIGN, ['-p', 'привет'], {
    cwd: gapWorkdir,
    // Порча самопроверки: отсутствующий ключ подставлен пустой строкой — процесс
    // перестаёт отличать «ключа нет» от «ключ задан пустым».
    portableEnv: () => (damage === 'empty-secret' ? { ...gap.env, [KEY_VAR]: '' } : gap.env),
  });
  if (gapSpawn.error) return fatal(`второй запуск не состоялся: ${gapSpawn.error.message}`);
  const gapDump = await waitForDump(gapWorkdir);
  if (!gapDump) return fatal('поддельный CLI не выгрузил окружение во втором прогоне');
  if (gapDump.env.has(KEY_VAR)) {
    problems.push(
      `отсутствующий ключ подставлен значением «${gapDump.env.get(KEY_VAR)}»: ` +
        'пустая строка выдана за ключ',
    );
  }

  // ── Розыск маркера всюду, где его быть не должно ────────────────────────────
  // Шифрованное хранилище (`provider-keys.enc`) в обходе участвует намеренно:
  // байты маркера в нём означали бы, что ключ лёг на диск открытым текстом.
  const hunted = [
    ...filesOf(appData),
    ...filesOf(home),
    ...filesOf(emptyStore),
    ...filesOf(workdir, new Set([DUMP])),
    ...filesOf(gapWorkdir, new Set([DUMP])),
  ];
  for (const path of hunted) {
    if (fileHasMarker(path)) problems.push(`значение ключа осело в файле: ${path}`);
  }
  if (report.includes(MARKER)) problems.push('значение ключа попало в строки отчёта');
  if (JSON.stringify(injection.lines).includes(MARKER)) {
    problems.push('значение ключа попало в состав добавки, который показывает панель');
  }
  const written = readFileSync(target.filePath, 'utf8');
  if (!written.includes('CC_CANON_VAR')) {
    problems.push('имя переменной в файл цели не записано — а оно обязано ехать');
  }
  const backups = filesOf(backupDir);
  if (backups.length === 0) {
    problems.push('резервная копия файла цели не сделана — искать ключ было негде');
  }

  return { problems, fatal: false, hunted: hunted.length, backups: backups.length };
}

async function main() {
  if (SELFTEST) {
    // Обе порчи обязаны покраснеть по отдельности: одна доказывает, что запись
    // ключа в файл замечается, вторая — что пустая строка вместо ключа не
    // проходит за «ключа нет».
    const cases = [
      ['write-to-file', 'ключ записан в файл цели по галочке'],
      ['empty-secret', 'вместо отсутствующего ключа подставлена пустая строка'],
    ];
    let missed = 0;
    for (const [damage, title] of cases) {
      const outcome = await probe(damage);
      cleanup();
      if (outcome.fatal) {
        console.error(`Самопроверка: стенд сломан на «${title}» — ${outcome.problems.join('; ')}`);
        missed += 1;
      } else if (outcome.problems.length === 0) {
        console.error(`Самопроверка: «${title}» прошла незамеченной — проверка не краснеет.`);
        missed += 1;
      } else {
        console.log(`Самопроверка: «${title}» замечена (${outcome.problems.length}).`);
        for (const problem of outcome.problems) console.log(`    · ${problem}`);
      }
    }
    process.exit(missed > 0 ? 1 : 0);
  }

  const outcome = await probe(null);
  cleanup();

  if (outcome.problems.length > 0) {
    console.error('Значение ключа оказалось не там, где ему место:');
    for (const problem of outcome.problems) console.error(`  · ${problem}`);
    process.exit(1);
  }

  console.log(
    `Ключ дошёл до окружения процесса и только до него: ${outcome.hunted} файлов осмотрено ` +
      `(из них ${outcome.backups} резервных копий), выключенная группа промолчала, ` +
      'отсутствующий ключ назван и пустой строкой не подменён.',
  );
}

// Типы снимаются самим Node с 22.18; на более старом 22.x нужен флаг, поэтому
// перезапускаем себя с ним, а не падаем с невнятным ERR_UNKNOWN_FILE_EXTENSION.
if (!process.features.typescript && !process.env.CC_SECRETS_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_SECRETS_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
