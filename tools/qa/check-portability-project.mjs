/**
 * Уровень проекта на всех десяти CLI (П2.5): что попадает в репозиторий, а что
 * в дом.
 *
 * Проверяются не пути в структуре — их держат юниты рядом, — а ДИСК: два
 * каталога снимаются побайтно, и после каждого переноса ровно один из них имеет
 * право измениться. Вопрос тикета ровно этот: проектная настройка, записанная в
 * дом, действует на все проекты человека сразу, и узнал бы он об этом только по
 * изменившемуся поведению.
 *
 * Репозиторий тест делает свой, во временном каталоге (приём
 * `check-worktrees.mjs`): так прогон не зависит ни от чужой истории, ни от
 * установленного CLI и ничего в проектах человека не трогает. Копия заводится
 * настоящим `git worktree` — на ней проверяется критерий 4.
 *
 * Четыре утверждения:
 *
 *  1. **Проектный перенос пишет только в проект.** Ни одного байта в доме цели.
 *  2. **Глобальный перенос не пишет в проект.** Обратная сторона того же.
 *  3. **Уровня нет — отказ, а не «сделаем как глобальный».** У провайдера без
 *     проектных путей перенос отказывается и не пишет никуда.
 *  4. **Копия репозитория уживается с зеркалом.** `.claude/skills` в копии —
 *     ССЫЛКА на оригинал; перенос пишет ЧЕРЕЗ неё, а не поверх, и второй копии
 *     скилла не появляется.
 *
 * Запуск: `node tools/qa/check-portability-project.mjs`
 * Самопроверка: `node tools/qa/check-portability-project.mjs --selftest` — портит
 * СНИМОК по каждой статье (изменённый файл, пропавший файл, лишний каталог) и
 * требует красного именно на ней, а ещё подсовывает путь ВНЕ проекта и требует,
 * чтобы проверка границ его поймала. Третья ложь — послабление для общего
 * `AGENTS.md`: оно проверяется четырьмя случаями, включая новый путь без следа
 * на диске. Проверка, которая не может покраснеть, — украшение.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
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
import { join, sep } from 'node:path';

/** Слово, которое лежит только в доме источника: по нему видно, что доехало. */
const SOURCE_MARKER = 'МАРКЕР-ИСТОЧНИКА-a71f3c';

const selftest = process.argv.includes('--selftest');
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'portability-project-')));
const home = join(root, 'home');
const targetHome = join(root, 'target-home');

// Переменные ставятся ДО первого импорта серверного кода: каталоги CLI
// вычисляются при вызове, и подменённый дом обязан быть виден уже первому.
process.env.HOME = targetHome;
process.env.USERPROFILE = targetHome;
process.env.CODEX_HOME = join(targetHome, '.codex');
process.env.QWEN_HOME = join(targetHome, '.qwen');
process.env.KIMI_CODE_HOME = join(targetHome, '.kimi-code');
process.env.XDG_CONFIG_HOME = join(targetHome, '.config');
process.env.APPDATA = join(targetHome, 'AppData', 'Roaming');
delete process.env.CLAUDE_CONFIG_DIR;

const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
}

function put(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом-источник Claude: по представителю на каждый слой, который возит перенос. */
function writeSource(dir) {
  put(join(dir, 'CLAUDE.md'), `Преамбула источника. ${SOURCE_MARKER}\n`);
  put(
    join(dir, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code' },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'node ./format.mjs' }] },
        ],
      },
    }),
  );
  put(
    join(dir, 'skills', 'doc-hygiene', 'SKILL.md'),
    ['---', 'name: doc-hygiene', 'description: Порядок в документах', '---', '', 'Тело.', ''].join(
      '\n',
    ),
  );
  put(join(dir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
}

/** Свой репозиторий с одним коммитом: на нём и проверяется проектный уровень. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'проект\n');
  git('add', '-A');
  git('commit', '-m', 'первый');
  return git;
}

/** Снимок каталога: путь → содержимое в hex, каталог → отметка. Ссылки не раскрываются. */
function snapshot(dir) {
  const entries = new Map();
  const walk = (current) => {
    let names;
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      // По ссылке не идём: у копии `.claude/skills` — junction на оригинал, и
      // обход по нему сравнивал бы каталог сам с собой.
      if (lstatSync(path).isSymbolicLink()) {
        entries.set(path, '<ссылка>');
        continue;
      }
      if (statSync(path).isDirectory()) {
        entries.set(path, '<каталог>');
        walk(path);
      } else {
        entries.set(path, readFileSync(path).toString('hex'));
      }
    }
  };
  walk(dir);
  return entries;
}

/** Чем снимок отличается от прежнего. Пустой список — каталог тот же до байта. */
function differences(before, after) {
  const found = [];
  for (const [path, content] of before) {
    if (!after.has(path)) found.push(`пропал ${path}`);
    else if (after.get(path) !== content) found.push(`изменён ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) found.push(`лишний ${path}`);
  return found;
}

/**
 * Записал ли перенос хоть что-то. Изменения снимка мало: корневой `AGENTS.md`
 * пишут несколько целей подряд, и второй владелец кладёт те же байты. Такая
 * запись засчитывается, только если путь УЖЕ был записан кем-то в этом прогоне;
 * новый путь без следа в снимке — по-прежнему провал.
 */
function wroteSomething(writes, changed, seen) {
  if (writes.length === 0) return false;
  return changed || writes.every((write) => seen.has(write.filePath));
}

/** Лежит ли путь внутри каталога. Сравнение по сегментам: `repo2` не внутри `repo`. */
function inside(dir, path) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

async function main() {
  writeSource(home);
  const project = join(root, 'repo');
  const git = makeRepo(project);

  const { importEnvironment } = await import(
    new URL('../../apps/server/src/domains/portability/import/index.ts', import.meta.url).href
  );
  const { emitEnvironment } = await import(
    new URL('../../apps/server/src/domains/portability/emit/index.ts', import.meta.url).href
  );
  const { ProjectLevelUnsupportedError } = await import(
    new URL('../../apps/server/src/domains/portability/project.ts', import.meta.url).href
  );
  const { linkSharedDirs } = await import(
    new URL('../../apps/server/src/domains/project-git/mirror-local.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );

  const env = importEnvironment({ provider: claudeProvider, scope: 'global', override: home });
  check('паспорт источника не пуст', env.items.length > 0);

  const providers = [claudeProvider, ...CATALOG_PROVIDERS];
  let written = 0;
  let poisoned = null;
  /** Пути, уже записанные предыдущей целью: общий `AGENTS.md` появляется здесь. */
  const writtenPaths = new Set();

  for (const provider of providers) {
    const deps = { target: provider, override: targetHome };

    // 1. Проектный перенос: меняется проект, дом цели — нет.
    const homeBefore = snapshot(targetHome);
    const projectBefore = snapshot(project);
    const projectPlan = emitEnvironment(env, { ...deps, scope: 'project', projectRoot: project });
    for (const write of projectPlan.writes) write.apply();
    written += projectPlan.writes.length;

    const outside = projectPlan.writes
      .map((write) => write.filePath)
      .filter((path) => !inside(project, path));
    check(
      `${provider.id}: проектный перенос пишет только внутрь проекта`,
      outside.length === 0,
      [...outside].join('; '),
    );
    const homeTouched = differences(homeBefore, snapshot(targetHome));
    check(
      `${provider.id}: проектный перенос не задел дом цели`,
      homeTouched.length === 0,
      homeTouched.join('; '),
    );
    // Один файл на двух целей — не ошибка, а смысл `AGENTS.md`: его корневой
    // экземпляр пишут и codex/kimi/opencode, и Claude (с 2.1.277, П2.7). Второй
    // владелец кладёт те же байты, снимок не меняется — и «ничего не записал»
    // было бы ложной краснотой. Поэтому запись доказывает себя сама: список не
    // пуст, файл после неё есть на диске, а изменение снимка требуется от ПЕРВОГО
    // владельца каждого пути. Пустой план по-прежнему краснеет.
    const projectChanged = differences(projectBefore, snapshot(project)).length > 0;
    check(
      `${provider.id}: проектный перенос что-то записал`,
      wroteSomething(projectPlan.writes, projectChanged, writtenPaths),
      projectPlan.writes.length === 0
        ? 'плана нет ни на один файл'
        : `снимок не изменился, хотя путь записан впервые: ${projectPlan.writes
            .map((write) => `${write.kind}→${write.filePath}`)
            .join('; ')}`,
    );
    const absent = projectPlan.writes
      .map((write) => write.filePath)
      .filter((path) => !existsSync(path));
    check(
      `${provider.id}: каждый файл проектной записи лежит на диске`,
      absent.length === 0,
      absent.join('; '),
    );
    for (const write of projectPlan.writes) writtenPaths.add(write.filePath);

    // 2. Глобальный перенос: меняется дом, проект — нет.
    const projectAfter = snapshot(project);
    const globalPlan = emitEnvironment(env, { ...deps, scope: 'global' });
    for (const write of globalPlan.writes) write.apply();
    written += globalPlan.writes.length;

    const projectTouched = differences(projectAfter, snapshot(project));
    check(
      `${provider.id}: глобальный перенос не задел проект`,
      projectTouched.length === 0,
      projectTouched.join('; '),
    );

    if (!poisoned) poisoned = { before: projectBefore, after: projectAfter };
  }

  // 3. Уровня у цели нет: отказ, и ни байта на диск.
  const { projectConfig: _dropped, ...rest } = CATALOG_PROVIDERS[0];
  const orphan = {
    ...rest,
    capabilities: { ...CATALOG_PROVIDERS[0].capabilities, projects: 'unsupported' },
  };
  const beforeRefusal = snapshot(root);
  let refused = null;
  try {
    emitEnvironment(env, { target: orphan, scope: 'project', projectRoot: project });
  } catch (error) {
    refused = error;
  }
  check(
    'цель без проектных путей: перенос отказался',
    refused instanceof ProjectLevelUnsupportedError,
    refused?.message,
  );
  const afterRefusal = differences(beforeRefusal, snapshot(root));
  check('цель без проектных путей: ни одного изменения на диске', afterRefusal.length === 0);

  // 4. Копия репозитория: зеркало кладёт `.claude/skills` ССЫЛКОЙ, и перенос
  //    обязан писать через неё, а не поверх.
  const copy = join(root, 'repo-copy');
  git('worktree', 'add', '-b', 'qa/portability-project', copy);
  mkdirSync(join(copy, '.claude'), { recursive: true });
  const linked = linkSharedDirs(project, copy);
  check(
    'зеркало связало .claude/skills копии с оригиналом',
    linked.linked.includes('.claude/skills'),
    JSON.stringify(linked.failed),
  );

  if (linked.linked.includes('.claude/skills')) {
    const mainSkill = join(project, '.claude', 'skills', 'doc-hygiene', 'SKILL.md');
    // Скилл убирается КАТАЛОГОМ: оставшаяся папка для адаптера означает «скилл
    // уже есть», и проверка увидела бы отказ вместо записи через ссылку.
    rmSync(join(mainSkill, '..'), { recursive: true, force: true });
    const copyPlan = emitEnvironment(env, {
      target: claudeProvider,
      scope: 'project',
      projectRoot: copy,
      override: targetHome,
    });
    for (const write of copyPlan.writes) write.apply();

    check(
      'перенос в копию не заменил ссылку каталогом',
      lstatSync(join(copy, '.claude', 'skills')).isSymbolicLink(),
    );
    check(
      'скилл лёг в ОРИГИНАЛ — одной копией на все параллельные каталоги',
      readFileSync(mainSkill, 'utf8').includes('doc-hygiene'),
    );
  }

  finish(poisoned, providers.length, written, project);
}

/**
 * Самопроверка: портится СНИМОК и проверка границ, а не диск.
 *
 * Сравнение снимков и `inside` — те два места, где эта проверка может соврать
 * зелёным: если они чего-то не замечают, все строки выше становятся украшением.
 */
function selfcheck(poisoned, project) {
  // Оба снимка — ОДИН и тот же: порча вносится в копию, и тогда каждая статья
  // отвечает своим словом. Пара «до/после» разных состояний смешала бы порчу с
  // настоящей разницей, и «изменён» читался бы как «лишний».
  const { after } = poisoned;
  const before = after;
  const anyFile = [...after.keys()].find((path) => after.get(path) !== '<каталог>');
  const anyDir = [...after.keys()].find((path) => after.get(path) === '<каталог>');
  const missed = [];

  const cases = [
    ['изменённый файл', new Map([...after, [anyFile, 'ff']]), 'изменён'],
    ['пропавший файл', new Map([...after].filter(([path]) => path !== anyFile)), 'пропал'],
    [
      'лишний каталог',
      new Map([...after, [join(anyDir ?? project, 'пустой'), '<каталог>']]),
      'лишний',
    ],
  ];

  for (const [name, poisonedAfter, word] of cases) {
    const found = differences(before, poisonedAfter);
    if (!found.some((line) => line.startsWith(word))) missed.push(name);
  }

  // Послабление для общего `AGENTS.md` — третье место, где проверка может
  // соврать зелёным: оно обязано засчитывать ТОЛЬКО путь, записанный кем-то
  // раньше в этом же прогоне.
  const seen = new Set([join(project, 'AGENTS.md')]);
  const shared = [{ filePath: join(project, 'AGENTS.md') }];
  const fresh = [{ filePath: join(project, '.codex', 'config.toml') }];
  if (wroteSomething([], true, seen)) missed.push('пустой план засчитан');
  if (wroteSomething(fresh, false, seen)) missed.push('новый путь без следа засчитан');
  if (!wroteSomething(shared, false, seen)) missed.push('общий AGENTS.md не засчитан');
  if (!wroteSomething(fresh, true, seen)) missed.push('настоящая запись не засчитана');

  // Путь ВНЕ проекта обязан быть пойман, а путь-сосед с общим началом
  // (`repo-copy` при корне `repo`) — не считаться «внутри».
  if (inside(project, join(root, 'home', 'settings.json'))) missed.push('путь вне проекта');
  if (inside(project, `${project}-copy`)) missed.push('каталог-сосед с общим началом');
  if (!inside(project, join(project, '.claude', 'settings.json')))
    missed.push('путь внутри проекта');

  return missed;
}

function finish(poisoned, targets, written, project) {
  const clean = () => rmSync(root, { recursive: true, force: true });

  if (selftest) {
    const missed = poisoned ? selfcheck(poisoned, project) : ['снимок не собран'];
    clean();
    if (missed.length > 0) {
      console.error(`Самопроверка: порча не поймана — ${missed.join(', ')}.`);
      process.exit(1);
    }
    console.log('Самопроверка: каждая порча снимка и границ поймана — проверка умеет краснеть.');
    return;
  }

  clean();

  if (failures.length > 0) {
    console.error('Уровень проекта: нарушения');
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  console.log(
    `Уровень проекта: ${targets} CLI, временный git-репозиторий, ${written} правок; ` +
      'проект и дом не задевают друг друга, копия репозитория пишет через ссылку зеркала.',
  );
}

await main();
