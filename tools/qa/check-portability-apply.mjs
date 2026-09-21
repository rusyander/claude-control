/**
 * Сделка переноса на всех десяти CLI (П2.3): показать → применить → отменить.
 *
 * Проверяется не план и не исходы — их держат `check-portability-roundtrip.mjs`
 * и юниты рядом, — а ДИСК: что остаётся в доме человека после каждого шага.
 * Вопрос тикета ровно этот, и ответ на него нельзя получить из отчёта самой
 * панели, поэтому дом снимается побайтно до и после, вместе с каталогами.
 *
 * Три утверждения на каждую цель:
 *
 *  1. **План не пишет ничего.** Дифф считается по временным копиям файлов, и
 *     дом после расчёта обязан быть тем же до байта.
 *  2. **Отмена возвращает дом к состоянию «до»** — вместе с каталогами, которые
 *     перенос создал сам: пустая папка скилла, оставшаяся после отмены, это не
 *     «как было», а скилл, которого у цели нет, но панель его увидит.
 *  3. **Провал на середине откатывает применённое.** Провал вносится намеренно
 *     последней правкой плана; дом обязан вернуться к тем же байтам.
 *
 * Запуск: `node tools/qa/check-portability-apply.mjs`
 * Самопроверка: `node tools/qa/check-portability-apply.mjs --selftest` — портит
 * СНИМОК дома по каждой статье (изменённый файл, пропавший файл, оставшийся
 * каталог) и требует, чтобы сравнение покраснело именно на ней. Проверка,
 * которая не может покраснеть, — украшение.
 */
import {
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

/** Текст человека в доме цели: перенос обязан оставить его дословно. */
const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';
/** Метка порядка байтов: в исходнике символ невидим, поэтому пишется кодом. */
const BOM = String.fromCharCode(0xfeff);

const selftest = process.argv.includes('--selftest');
const home = mkdtempSync(join(tmpdir(), 'portability-apply-'));
/** Каталог копий лежит ВНЕ дома: иначе он попадал бы в снимок сравнения. */
const backupDir = mkdtempSync(join(tmpdir(), 'portability-apply-backups-'));

// Переменные ставятся ДО первого импорта серверного кода: каталоги CLI
// вычисляются при вызове, и подменённый дом обязан быть виден уже первому.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = join(home, '.codex');
process.env.QWEN_HOME = join(home, '.qwen');
process.env.KIMI_CODE_HOME = join(home, '.kimi-code');
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.APPDATA = join(home, 'AppData', 'Roaming');
delete process.env.CLAUDE_CONFIG_DIR;

const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
}

function put(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом-источник: по разделу на каждый слой, который эта волна возит. */
function writeSource(root) {
  const claude = join(root, '.claude');
  put(
    join(claude, 'settings.json'),
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
    join(claude, 'CLAUDE.md'),
    ['Преамбула источника.', '', '## ПРАВИЛО: По-русски', '', 'По-русски.', ''].join('\n'),
  );
  put(
    join(claude, 'skills', 'doc-hygiene', 'SKILL.md'),
    ['---', 'name: doc-hygiene', 'description: Порядок в документах', '---', '', 'Тело.', ''].join(
      '\n',
    ),
  );
  put(
    join(claude, 'commands', 'review.md'),
    ['---', 'description: Ревью изменений', '---', '', 'Посмотри диф.', ''].join('\n'),
  );
}

/**
 * Соседи в домах целей: текст человека и чужой ключ. Они здесь не ради полноты
 * — без существующих файлов проверялась бы только ветка «создать с нуля», а
 * теряется чужое как раз при правке существующего.
 */
function writeNeighbours(root) {
  put(join(root, '.codex', 'AGENTS.md'), `${HUMAN_TEXT}\n`);
  put(join(root, '.codex', 'config.toml'), ['model = "o3"', ''].join('\n'));
  // Метка порядка байтов и окончания Windows: так файл оставляют Блокнот и git.
  put(join(root, '.gemini', 'GEMINI.md'), `${BOM}${HUMAN_TEXT}\r\n`);
  put(join(root, '.gemini', 'settings.json'), JSON.stringify({ theme: 'мой' }));
  put(
    join(root, '.kimi-code', 'config.toml'),
    ['default_permission_mode = "manual"', ''].join('\n'),
  );
}

/**
 * Снимок дома: путь → содержимое в hex, каталог → отметка.
 *
 * Каталоги в снимке не для полноты: отмена, удалившая файл и оставившая папку,
 * вернула бы дом «почти как было», и отличить это от настоящего возврата можно
 * только так.
 */
function snapshot(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        entries.set(path, '<каталог>');
        walk(path);
      } else {
        entries.set(path, readFileSync(path).toString('hex'));
      }
    }
  };
  walk(root);
  return entries;
}

/** Чем снимок отличается от прежнего. Пустой список — дом тот же до байта. */
function differences(before, after) {
  const found = [];
  for (const [path, content] of before) {
    if (!after.has(path)) found.push(`пропал ${path}`);
    else if (after.get(path) !== content) found.push(`изменён ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) found.push(`лишний ${path}`);
  return found;
}

/** Правка, которая всегда проваливается: ею вносится намеренный провал. */
function poison(filePath) {
  return {
    kind: 'skill',
    itemIds: ['ядовитая'],
    filePath,
    apply: () => {
      throw new Error('запись не удалась нарочно');
    },
    applyTo: () => {
      throw new Error('запись не удалась нарочно');
    },
  };
}

/** Перенос в свой же CLI — в ДРУГОЙ каталог: это «на другую машину». */
function overrideOf(providerId) {
  return providerId === 'claude' ? join(home, '.claude-target') : undefined;
}

async function main() {
  writeSource(home);
  writeNeighbours(home);

  const { importEnvironment } = await import(
    new URL('../../apps/server/src/domains/portability/import/index.ts', import.meta.url).href
  );
  const { buildTransferPlan } = await import(
    new URL('../../apps/server/src/domains/portability/plan.ts', import.meta.url).href
  );
  const { applyTransfer, revertTransfer } = await import(
    new URL('../../apps/server/src/domains/portability/apply.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );

  const env = importEnvironment({ provider: claudeProvider, scope: 'global' });
  check('паспорт источника не пуст', env.items.length > 0);

  const providers = [claudeProvider, ...CATALOG_PROVIDERS];
  let applied = 0;
  let poisoned = null;

  for (const provider of providers) {
    const override = overrideOf(provider.id);
    const at = '2026-09-20T10:00:00.000Z';
    const before = snapshot(home);

    const shown = buildTransferPlan(env, provider, { scope: 'global', override }, at);
    check(`${provider.id}: план не пишет ничего`, differences(before, snapshot(home)).length === 0);

    const files = applyTransfer(shown.plan.target, shown.plan.root, shown.writes, backupDir);
    applied += files.length;
    if (shown.writes.length > 0) {
      check(
        `${provider.id}: применение что-то изменило`,
        differences(before, snapshot(home)).length > 0,
      );
    }

    const record = {
      source: env.provider,
      target: shown.plan.target,
      scope: 'global',
      appliedAt: at,
      fingerprint: shown.plan.fingerprint,
      files,
    };
    const answer = revertTransfer(record, []);
    check(`${provider.id}: отмена ничего не оставила незакрытым`, answer.record === null);
    check(
      `${provider.id}: отмена никого не сочла изменённым`,
      answer.changedSince.length === 0,
      answer.changedSince.join(', '),
    );

    const afterRevert = snapshot(home);
    const left = differences(before, afterRevert);
    check(
      `${provider.id}: после отмены дом байт в байт как до переноса`,
      left.length === 0,
      left.join('; '),
    );

    // Намеренный провал последней правкой: откат обязан вернуть всё.
    const second = buildTransferPlan(env, provider, { scope: 'global', override }, at);
    const failing = join(shown.plan.root || home, 'не-существующий', 'файл.toml');
    let thrown = null;
    try {
      applyTransfer(
        second.plan.target,
        second.plan.root,
        [...second.writes, poison(failing)],
        backupDir,
      );
    } catch (error) {
      thrown = error;
    }
    check(`${provider.id}: провал записи остановил перенос`, thrown !== null);
    check(
      `${provider.id}: провал объявлен откаченным`,
      thrown?.rolledBack === true,
      thrown?.message,
    );
    const afterFailure = differences(before, snapshot(home));
    check(
      `${provider.id}: после провала дом байт в байт как до переноса`,
      afterFailure.length === 0,
      afterFailure.join('; '),
    );

    if (!poisoned) poisoned = { before, after: afterRevert };
  }

  finish(poisoned, providers.length, applied);
}

/**
 * Самопроверка: портится СНИМОК, а не дом.
 *
 * Сравнение снимков — то место, где эта проверка может соврать зелёным: если
 * `differences` чего-то не замечает, все двенадцать строк выше становятся
 * украшением. Поэтому каждая статья порчи требует красного по своему слову.
 */
function selfcheck(poisoned) {
  const { before, after } = poisoned;
  const anyFile = [...after.keys()].find((path) => after.get(path) !== '<каталог>');
  const anyDir = [...after.keys()].find((path) => after.get(path) === '<каталог>');
  const missed = [];

  const cases = [
    ['изменённый файл', new Map([...after, [anyFile, 'ff']]), 'изменён'],
    ['пропавший файл', new Map([...after].filter(([path]) => path !== anyFile)), 'пропал'],
    [
      'оставшийся каталог',
      new Map([...after, [join(anyDir ?? home, 'пустой'), '<каталог>']]),
      'лишний',
    ],
  ];

  for (const [name, poisonedAfter, word] of cases) {
    const found = differences(before, poisonedAfter);
    if (!found.some((line) => line.startsWith(word))) missed.push(name);
  }
  return missed;
}

function finish(poisoned, targets, applied) {
  if (selftest) {
    const missed = poisoned ? selfcheck(poisoned) : ['снимок не собран'];
    rmSync(home, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    if (missed.length > 0) {
      console.error(`Самопроверка: порча снимка не поймана — ${missed.join(', ')}.`);
      process.exit(1);
    }
    console.log(
      'Самопроверка: каждая порча снимка дома поймана своей статьёй — проверка умеет краснеть.',
    );
    return;
  }

  rmSync(home, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error('Сделка переноса: нарушения');
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  console.log(
    `Сделка переноса: ${targets} CLI, временный дом, ${applied} файлов записано и возвращено; ` +
      'отмена и откат при провале возвращают дом байт в байт.',
  );
}

await main();
