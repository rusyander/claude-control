/**
 * Импортёры среды десяти CLI на ЖИВЫХ файлах (П0.2).
 *
 * Чем это отличается от модульных тестов рядом. `import.test.ts` разворачивает
 * эталонный дом ОДНОГО Claude; здесь разворачивается дом ВСЕХ ДЕСЯТИ: временный
 * каталог подставляется вместо домашнего (`HOME`/`USERPROFILE` и
 * задокументированные переменные каждого CLI), в него кладётся по одному живому
 * представителю каждого раздела, и паспорт собирается тем же кодом, каким панель
 * собирает его человеку. Рукотворные структуры, поданные прямо в нормализатор,
 * доказали бы таблицу, а не систему.
 *
 * Что проверяется:
 *   1. импортёр есть у всех десяти, и ни один не бросает на разделе, которого у
 *      провайдера нет, — раздел приезжает ПРОПУСКОМ С ПРИЧИНОЙ;
 *   2. у каждого CLI в канон доезжают названные записи (инструкции, MCP, права,
 *      хуки, скиллы, команды — по тому, что у него есть);
 *   3. значение-маркер секрета не появляется НИГДЕ ни в одном паспорте;
 *   4. цикл `@`-импортов назван файлом, а не проглочен;
 *   5. недоступный скрипт хука даёт ХУДШИЙ уровень требований, а не пустой
 *      список.
 *
 * Запуск: `node tools/qa/check-portability-import.mjs`
 * Самопроверка: `node tools/qa/check-portability-import.mjs --selftest` —
 * ломает эталон намеренно и требует, чтобы проверка покраснела. Проверка,
 * которая не может покраснеть, — украшение.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Значение-маркер: доехало до канона — проверка обязана покраснеть. */
const SECRET_VALUE = 'sk-МАРКЕР-a41d90c2-НЕ-ДОЛЖЕН-УТЕЧЬ';

const selftest = process.argv.includes('--selftest');
const home = mkdtempSync(join(tmpdir(), 'portability-home-'));

// Переменные ставятся ДО первого импорта серверного кода: каталоги CLI
// вычисляются при вызове, и подменённый дом обязан быть виден уже первому.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
process.env.CODEX_HOME = join(home, '.codex');
process.env.QWEN_HOME = join(home, '.qwen');
process.env.KIMI_CODE_HOME = join(home, '.kimi-code');
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.APPDATA = join(home, 'AppData', 'Roaming');

const failures = [];

/** Записать файл, создав каталоги по пути. */
function put(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeFixtures(root) {
  // --- Claude ---------------------------------------------------------------
  const claude = join(root, '.claude');
  put(
    join(claude, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET_VALUE, OPENAI_KEY: SECRET_VALUE },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node ./нет-такого/скрипта.mjs' }] }],
      },
    }),
  );
  put(
    join(claude, 'CLAUDE.md'),
    [
      'Преамбула.',
      '',
      '@imported.md',
      '',
      '## ПРАВИЛО: Отвечать по-русски',
      '',
      'По-русски.',
      '',
    ].join('\n'),
  );
  put(join(claude, 'imported.md'), ['Текст импорта.', '', '@CLAUDE.md', ''].join('\n'));
  put(
    join(claude, 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: Ревьюер',
      'omitClaudeMd: true',
      '---',
      '',
      'Смотри.',
      '',
    ].join('\n'),
  );
  put(join(claude, '.claude.json'), JSON.stringify({ mcpServers: { inside: { type: 'sdk' } } }));

  // --- Codex ----------------------------------------------------------------
  put(join(root, '.codex', 'AGENTS.md'), 'Инструкции Codex.\n');
  put(
    join(root, '.codex', 'config.toml'),
    [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.files]',
      'command = "npx"',
      'args = ["-y", "mcp-files"]',
      '',
      '[mcp_servers.files.env]',
      `FILES_TOKEN = "${SECRET_VALUE}"`,
      '',
      '[shell_environment_policy.set]',
      'EDITOR = "code"',
      '',
    ].join('\n'),
  );

  // --- Gemini ---------------------------------------------------------------
  put(join(root, '.gemini', 'GEMINI.md'), 'Инструкции Gemini.\n');
  put(
    join(root, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: { files: { command: 'npx', args: ['-y', 'mcp-files'] } },
      general: { defaultApprovalMode: 'default' },
      coreTools: ['ReadFile'],
      excludeTools: ['ShellTool'],
    }),
  );
  // Три формы имени ключа НАРОЧНО: `GEMINI_API_KEY` ловило ещё прежнее правило,
  // а `OPENAI_KEY` и `GITHUB_PAT` — именно те формы, на которых оно молчало и
  // пускало значение в канон открытым текстом (ревью волны П0).
  put(
    join(root, '.gemini', '.env'),
    [
      'EDITOR=code',
      `GEMINI_API_KEY=${SECRET_VALUE}`,
      `OPENAI_KEY=${SECRET_VALUE}`,
      `GITHUB_PAT=${SECRET_VALUE}`,
      '',
    ].join('\n'),
  );
  put(
    join(root, '.gemini', 'commands', 'review.toml'),
    ['description = "Ревью"', 'prompt = "Посмотри {{args}}."', ''].join('\n'),
  );

  // --- Qwen -----------------------------------------------------------------
  put(join(root, '.qwen', 'QWEN.md'), 'Инструкции Qwen.\n');
  put(
    join(root, '.qwen', 'settings.json'),
    JSON.stringify({
      mcpServers: { files: { command: 'npx', args: ['-y', 'mcp-files'] } },
      tools: { approvalMode: 'default' },
      permissions: { allow: ['ReadFile'], deny: ['ShellTool'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Shell',
            hooks: [{ type: 'command', command: 'node guard.mjs', timeout: 5000 }],
          },
        ],
      },
    }),
  );
  put(join(root, '.qwen', '.env'), 'EDITOR=code\n');
  put(
    join(root, '.qwen', 'skills', 'demo', 'SKILL.md'),
    ['---', 'name: demo', 'description: Скилл Qwen', '---', '', 'Тело.', ''].join('\n'),
  );

  // --- Kimi -----------------------------------------------------------------
  put(join(root, '.kimi-code', 'AGENTS.md'), 'Инструкции Kimi.\n');
  put(
    join(root, '.kimi-code', 'mcp.json'),
    JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'mcp-files'] } } }),
  );
  put(
    join(root, '.kimi-code', 'config.toml'),
    [
      // Режим — СКАЛЯРНЫЙ ключ корня, правила — массив таблиц (`lib/kimi-toml.ts`).
      'default_permission_mode = "manual"',
      '',
      '[[permission.rules]]',
      'pattern = "Bash(git push:*)"',
      'decision = "deny"',
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      'command = "node guard.mjs"',
      'timeout = 60',
      '',
    ].join('\n'),
  );
  put(
    join(root, '.kimi-code', 'skills', 'demo', 'SKILL.md'),
    ['---', 'name: demo', 'description: Скилл Kimi', '---', '', 'Тело.', ''].join('\n'),
  );

  // --- Cursor ---------------------------------------------------------------
  put(
    join(root, '.cursor', 'rules', 'style.mdc'),
    ['---', 'description: Стиль', '---', '', 'Пиши коротко.', ''].join('\n'),
  );
  put(
    join(root, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'mcp-files'] } } }),
  );
  put(
    join(root, '.cursor', 'cli-config.json'),
    JSON.stringify({ permissions: { allow: ['Read(**)'], deny: ['Shell(rm *)'] } }),
  );

  // --- Continue -------------------------------------------------------------
  put(
    join(root, '.continue', 'config.yaml'),
    [
      'mcpServers:',
      '  - name: files',
      '    command: npx',
      '    args:',
      '      - -y',
      '      - mcp-files',
      '',
    ].join('\n'),
  );
  put(
    join(root, '.continue', 'permissions.yaml'),
    [
      'allow:',
      '  - readFile',
      'ask:',
      '  - runTerminalCommand',
      'exclude:',
      '  - editFile',
      '',
    ].join('\n'),
  );
  put(join(root, '.continue', '.env'), 'EDITOR=code\n');

  // --- Goose ----------------------------------------------------------------
  const goose =
    process.platform === 'win32'
      ? join(root, 'AppData', 'Roaming', 'Block', 'goose', 'config')
      : join(root, '.config', 'goose');
  put(join(goose, '.goosehints'), 'Подсказки Goose.\n');
  put(
    join(goose, 'config.yaml'),
    [
      'GOOSE_MODE: approve',
      'extensions:',
      '  files:',
      '    type: stdio',
      '    cmd: npx',
      '    args:',
      '      - -y',
      '      - mcp-files',
      '    enabled: true',
      '',
    ].join('\n'),
  );

  // --- OpenCode -------------------------------------------------------------
  const opencode = join(root, '.config', 'opencode');
  put(join(opencode, 'AGENTS.md'), 'Инструкции OpenCode.\n');
  put(
    join(opencode, 'opencode.json'),
    JSON.stringify({
      mcp: { files: { type: 'local', command: ['npx', '-y', 'mcp-files'], enabled: true } },
      permission: { bash: 'ask', edit: 'allow' },
      // Хуки OpenCode живут под `experimental.hook` — и это признано
      // нестабильным разделом самим OpenCode.
      experimental: {
        hook: {
          file_edited: { '*.ts': [{ command: ['node', 'format.mjs'] }] },
          session_completed: [{ command: ['node', 'done.mjs'] }],
        },
      },
    }),
  );

  // --- Aider ----------------------------------------------------------------
  put(join(root, 'conventions.md'), 'Соглашения проекта.\n');
  put(
    join(root, '.aider.conf.yml'),
    ['read:', `  - ${join(root, 'conventions.md')}`, ''].join('\n'),
  );
}

/** Один пункт ожидания: описание плюс предикат по паспорту. */
function check(name, ok) {
  if (!ok) failures.push(name);
}

function has(items, kind, predicate) {
  return items.some((item) => item.kind === kind && predicate(item));
}

function named(items, kind, name) {
  return has(items, kind, (item) => item.name === name || item.fileName === name);
}

async function main() {
  writeFixtures(home);

  const registry = await import(
    new URL('../../apps/server/src/domains/portability/import/index.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );

  const providers = [claudeProvider, ...CATALOG_PROVIDERS];
  check('импортёр заведён у всех десяти', registry.importerProviderIds().length === 10);
  check('каталог отдаёт десять провайдеров', providers.length === 10);

  const passports = new Map();
  for (const provider of providers) {
    let passport;
    try {
      passport = registry.importEnvironment({ provider, scope: 'global' });
    } catch (error) {
      failures.push(`${provider.id}: импортёр бросил — ${error.message}`);
      continue;
    }
    passports.set(provider.id, passport);
  }

  invariants(passports);
  expectations(passports);

  const report = selftest ? selfcheck(passports) : null;
  finish(report);
}

/**
 * Инварианты, которые обязаны держаться у КАЖДОГО паспорта.
 *
 * Вынесены из цикла разбора нарочно: самопроверка гоняет их по ОТРАВЛЕННОМУ
 * паспорту и требует, чтобы каждая порча была поймана своей проверкой. Пока эти
 * три строки жили внутри цикла, самопроверка их не исполняла вовсе — и та, что
 * стережёт инвариант 5, не могла покраснеть ни на чём.
 */
function invariants(passports) {
  for (const [id, passport] of passports) {
    // Пропуск без причины из словаря — это молчание, а не объяснение.
    for (const skip of passport.skipped) {
      check(`${id}: у пропуска есть подробность`, Boolean(skip.detail));
    }
    // Значение секрета не должно появиться НИГДЕ: ни в записи, ни в `raw`.
    check(
      `${id}: значение секрета не попало в паспорт`,
      !JSON.stringify(passport).includes(SECRET_VALUE),
    );
    // Повтор `id` — не косметика: по нему идёт идемпотентный upsert
    // (инвариант 10), и две записи под одним ключом у цели сливаются в одну.
    const ids = passport.items.map((item) => item.id);
    check(`${id}: ни один id не повторяется`, ids.length === new Set(ids).size);
  }
}

/** Названные записи, которые обязаны доехать у каждого CLI. */
function expectations(passports) {
  const claude = passports.get('claude');
  if (claude) {
    const items = claude.items;
    check(
      'claude: правило CLAUDE.md отдельной записью',
      has(items, 'instructions', (item) => item.fileName.includes('#')),
    );
    check(
      'claude: субагент с omitClaudeMd',
      has(items, 'subagent', (item) => item.omitInstructions),
    );
    check(
      'claude: запись sdk названа причиной',
      claude.skipped.some((skip) => skip.detail.includes('процесса SDK')),
    );
    check(
      'claude: цикл импортов назван',
      claude.skipped.some((skip) => skip.detail.includes('цикл импортов')),
    );
    check(
      'claude: недоступный скрипт хука даёт худший уровень',
      has(items, 'hook', (item) => item.needs.resolution === 'undetermined'),
    );
  } else {
    failures.push('claude: паспорт не собран');
  }

  const table = [
    [
      'codex',
      (items) =>
        named(items, 'instructions', 'AGENTS.md') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.rule === 'mode:on-request') &&
        named(items, 'envVar', 'EDITOR'),
    ],
    [
      'gemini',
      (items) =>
        named(items, 'instructions', 'GEMINI.md') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.rule === 'mode:default') &&
        named(items, 'command', 'review'),
    ],
    [
      'qwen',
      (items) =>
        named(items, 'instructions', 'QWEN.md') &&
        named(items, 'skill', 'demo') &&
        has(items, 'hook', (item) => item.timeout?.unit === 'ms'),
    ],
    [
      'kimi',
      (items) =>
        named(items, 'instructions', 'AGENTS.md') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.rule === 'Bash(git push:*)') &&
        named(items, 'skill', 'demo'),
    ],
    [
      'cursor',
      (items) =>
        named(items, 'instructions', 'style.mdc') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.decision === 'deny'),
    ],
    [
      'continue',
      (items) =>
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.rule === 'editFile' && item.decision === 'deny'),
    ],
    [
      'goose',
      (items) =>
        named(items, 'instructions', '.goosehints') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'permission', (item) => item.rule === 'mode:approve'),
    ],
    [
      'opencode',
      (items) =>
        named(items, 'instructions', 'AGENTS.md') &&
        named(items, 'mcpServer', 'files') &&
        has(items, 'hook', (item) => item.command.includes('format.mjs')),
    ],
    ['aider', (items) => named(items, 'instructions', 'conventions.md')],
  ];

  for (const [id, predicate] of table) {
    const passport = passports.get(id);
    if (!passport) {
      failures.push(`${id}: паспорт не собран`);
      continue;
    }
    check(`${id}: названные записи доехали до канона`, predicate(passport.items));
  }
}

/**
 * Самопроверка: эталон ломается намеренно, и проверка ОБЯЗАНА покраснеть. Без
 * этого зелёный прогон ничего не значит — он мог бы быть зелёным и на пустом
 * паспорте.
 */
function selfcheck(passports) {
  const before = failures.length;
  const broken = new Map(
    [...passports].map(([id, passport]) => [id, { ...passport, items: [], skipped: [] }]),
  );
  expectations(broken);
  const caught = failures.length - before;

  // Пустой паспорт инварианты не ловят — он пуст и потому «чист». Поэтому вторая
  // половина самопроверки кормит их паспортом, ИСПОРЧЕННЫМ по каждой из трёх
  // статей, и требует каждую претензию ПО ИМЕНИ: счётчик претензий не сказал бы,
  // какая именно проверка ослепла.
  const poisonedAt = failures.length;
  invariants(poison(passports));
  const raised = failures.slice(poisonedAt);
  const missed = [
    ['значение секрета в записи', 'значение секрета не попало'],
    ['два id под одним ключом', 'ни один id не повторяется'],
    ['пропуск без подробности', 'у пропуска есть подробность'],
  ]
    .filter(([, needle]) => !raised.some((failure) => failure.includes(needle)))
    .map(([name]) => name);

  // Собственные находки самопроверки в итог не идут: она проверяет проверку.
  failures.length = before;
  return { caught, missed };
}

/** Паспорт, испорченный по каждой статье инвариантов: маркер, повтор id, пустая причина. */
function poison(passports) {
  const source = passports.get('claude') ?? [...passports.values()][0];
  const [first, second] = source.items;
  return new Map([
    [
      'отравленный',
      {
        ...source,
        items: [
          { ...first, raw: `ANTHROPIC_API_KEY=${SECRET_VALUE}` },
          { ...second, id: first.id },
        ],
        skipped: [{ kind: 'hook', reason: 'no_section', detail: '' }],
      },
    ],
  ]);
}

function finish(report) {
  rmSync(home, { recursive: true, force: true });

  if (report) {
    if (report.missed.length > 0) {
      console.error(
        `Самопроверка: отравленный паспорт не пойман по статьям — ${report.missed.join(', ')}.`,
      );
      process.exit(1);
    }
    if (report.caught < 10) {
      console.error(
        `Самопроверка: пустой паспорт дал лишь ${report.caught} претензий — проверка слепа.`,
      );
      process.exit(1);
    }
    console.log(
      `Самопроверка: пустой паспорт даёт ${report.caught} претензий, отравленный пойман по всем трём статьям — проверка умеет краснеть.`,
    );
  }

  if (failures.length > 0) {
    console.error('Импорт среды: расхождения с эталоном');
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  console.log('Импорт среды: десять CLI, эталонный дом, паспорта сошлись.');
}

await main();
