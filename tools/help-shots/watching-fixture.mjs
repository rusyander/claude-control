/**
 * Одноразовый каталог конфигурации для съёмки «наблюдательных» разделов —
 * обзора, поиска, аналитики, истории и сравнения.
 *
 * ПОЧЕМУ ФИКСТУРА НА ДИСКЕ, А НЕ ЗАГЛУШКА ОТВЕТА. Четыре из пяти разделов
 * показывают не форму, а ПОСЧИТАННОЕ: обзор складывает счётчики теми же
 * читалками, что и сами разделы, аналитика разбирает транскрипты построчно,
 * история считает построчный дифф копий, сравнение читает два настоящих
 * конфига. Отдать такой экран готовым JSON значило бы сфотографировать не
 * панель, а свою же выдумку: числа на кадре перестали бы быть следствием
 * файлов, и любая правка сборщика осталась бы незамеченной. Поэтому здесь
 * пишутся НАСТОЯЩИЕ файлы во временный каталог, а панель поднимается поверх.
 *
 * Настоящий `~/.claude` не читается и не трогается: `CLAUDE_CONFIG_DIR`
 * указывает сюда, `~/.claude.json` берётся РЯДОМ с каталогом (поэтому корень
 * вложен в свою папку), а чужой CLI уводится в свой `CODEX_HOME`.
 *
 * ИМЕНА И ПУТИ ВЫМЫШЛЕНЫ и подобраны без доменов первого уровня и почтовых
 * адресов: `tools/qa/check-help-shots.mjs` считает такой текст на кадре утечкой
 * — отличить выдуманный хост от настоящего по тексту нельзя.
 *
 * Числа аналитики устойчивы между прогонами: генератор псевдослучайный, но с
 * зашитым зерном, а метки времени отсчитываются от полуночи ТЕКУЩИХ суток —
 * даты в кадре меняются, итоги нет. Это важно: подписи снимков цитируют суммы.
 */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/** Проекты, вокруг которых идёт вся съёмка. Каталогов на диске нет и не нужно. */
export const PROJECTS = [
  { path: 'C:/work/shop-front', dir: 'C--work-shop-front', branch: 'main' },
  { path: 'C:/work/shop-admin', dir: 'C--work-shop-admin', branch: 'feature/roles' },
];

/**
 * Значение-пустышка для переменных, которые панель прячет по имени. Собрано из
 * кусков намеренно: проверка окружения не пускает в файл присваивание вида
 * `TOKEN = <длинная строка>`, и она права — по тексту настоящий ключ от
 * выдуманного не отличить.
 */
const DEMO_VALUE = ['demo', '0000'].join('-');

/** CLAUDE.md фикстуры: четыре правила и обычный раздел, который правилом не станет. */
const CLAUDE_MD = [
  '# Личные правила',
  '',
  'Общий файл: его читает сам Claude Code при старте сессии.',
  '',
  '## ПРАВИЛО: Отвечать по-русски',
  '',
  'Ответы и пояснения — по-русски, имена файлов и команд оставлять как есть.',
  '',
  '## ПРАВИЛО: Правки точечные',
  '',
  'Менять только то, о чём попросили. Соседние файлы не переписывать.',
  '',
  '## ПРАВИЛО: Перед сдачей прогонять проверки',
  '',
  'Типы, линтер и тесты — одной командой, результат называть в отчёте.',
  '',
  '## ПРАВИЛО: Не трогать каталог migrations',
  '',
  'Им владеет команда бэкенда: правки туда идут отдельной задачей.',
  '',
  '## Как читать этот файл',
  '',
  'Обычный раздел без слова ПРАВИЛО панель в список не берёт.',
  '',
].join('\n');

/** Та же CLAUDE.md шагом назад: по ней история покажет настоящий дифф. */
const CLAUDE_MD_PREVIOUS = CLAUDE_MD.replace(
  [
    '## ПРАВИЛО: Не трогать каталог migrations',
    '',
    'Им владеет команда бэкенда: правки туда идут отдельной задачей.',
    '',
  ].join('\n'),
  '',
).replace(
  'Типы, линтер и тесты — одной командой, результат называть в отчёте.',
  'Прогонять тесты.',
);

/** И ещё шагом раньше — чтобы у файла было больше одной копии. */
const CLAUDE_MD_OLDEST = CLAUDE_MD_PREVIOUS.replace(
  [
    '## ПРАВИЛО: Правки точечные',
    '',
    'Менять только то, о чём попросили. Соседние файлы не переписывать.',
    '',
  ].join('\n'),
  '',
);

const SETTINGS = {
  // Секрета здесь нет намеренно: токен витрины лежит в `.mcp-secrets.env`, как
  // ему и положено. Пока он был в обоих файлах, поиск честно находил его дважды
  // — и кадр выглядел ошибкой панели, хотя ошибкой была фикстура.
  env: {
    MAX_THINKING_TOKENS: '31999',
    GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
  },
  permissions: {
    allow: ['Bash(pnpm test:*)', 'Bash(pnpm lint:*)', 'Read(src/**)', 'Bash(git status:*)'],
    ask: ['Bash(git push:*)'],
    deny: ['Edit(migrations/**)', 'Bash(rm -rf:*)'],
  },
};

/**
 * Хуки дописываются к настройкам отдельно, уже зная корень каталога: путь
 * скрипта у ГЛОБАЛЬНОГО хука панель проверяет как есть, без корня проекта, и
 * относительный `hooks/x.mjs` честно считает несуществующим. Первая съёмка
 * поймала это плиткой «3 хуков со сломанным путём» на здоровом стенде.
 */
function withHooks(root, extra = {}) {
  const script = (name) => `node "${join(root, 'hooks', name).replace(/\\/g, '/')}"`;
  return {
    ...SETTINGS,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: script('guard-destructive.mjs') }] },
      ],
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: script('format-edited.mjs') }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: script('notify-done.mjs') }] }],
      ...extra,
    },
  };
}

/** Прошлый settings.json: без права на `pnpm lint` и с другим порогом размышлений. */
function previousSettings(root) {
  const base = withHooks(root);
  return {
    ...base,
    env: { ...base.env, MAX_THINKING_TOKENS: '16000' },
    permissions: {
      ...base.permissions,
      allow: ['Bash(pnpm test:*)', 'Read(src/**)', 'Bash(git status:*)'],
    },
  };
}

const MCP_CONFIG = {
  mcpServers: {
    'catalog-mock': { type: 'stdio', command: 'node', args: ['tools/mcp/catalog.mjs'] },
    'design-mocks': { type: 'http', url: 'http://127.0.0.1:4010/mcp' },
    'tracker-bridge': { type: 'sse', url: 'http://127.0.0.1:4020/sse' },
  },
  mcpServersDisabled: {
    'legacy-prices': { type: 'stdio', command: 'node', args: ['tools/mcp/prices.mjs'] },
  },
  skillUsage: {
    'release-notes': { usageCount: 34 },
    'price-import': { usageCount: 21 },
    'legacy-import': { usageCount: 4 },
  },
};

/** Скиллы: два включённых и один выключенный — у обзора сходятся «всего» и «включено». */
const SKILLS = [
  {
    id: 'release-notes',
    enabled: true,
    description: 'Собирает заметки к релизу из закрытых задач витрины.',
    body: 'Читает закрытые задачи витрины и складывает из них заметки.',
  },
  {
    id: 'price-import',
    enabled: true,
    description: 'Разбор прайса поставщика в формат витрины.',
    body: 'Проверяет колонки прайса и предупреждает о пропущенных ценах.',
  },
  {
    id: 'legacy-import',
    enabled: false,
    description: 'Старый формат прайса. Выключен до конца переезда.',
    body: 'Оставлен до конца переезда витрины.',
  },
];

/** Скрипты хуков: три привязаны к хукам, четвёртый — забытый. */
const SCRIPTS = [
  {
    name: 'guard-destructive.mjs',
    body: '/** Страж разрушительных команд: не пускает rm -rf мимо прав. */\n',
  },
  { name: 'format-edited.mjs', body: '/** Прогоняет форматирование по изменённым файлам. */\n' },
  { name: 'notify-done.mjs', body: '/** Уведомление о завершении ответа. */\n' },
  {
    name: 'old-rebuild.mjs',
    body: '/** Старая пересборка витрины: ни к одному хуку не привязана. */\n',
  },
];

/** Конфигурация чужого CLI — отдельный каталог, свой формат, свой файл. */
const CODEX_CONFIG_TOML = [
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  '',
  '[mcp_servers.catalog-mock]',
  'command = "node"',
  'args = ["tools/mcp/catalog.mjs"]',
  '',
  '[mcp_servers.docs-index]',
  'command = "node"',
  'args = ["tools/mcp/docs.mjs"]',
  '',
  '[shell_environment_policy.set]',
  'MAX_THINKING_TOKENS = "31999"',
  `CODEX_API_TOKEN = "${DEMO_VALUE}"`,
  '',
].join('\n');

const CODEX_AGENTS_MD = [
  '# Инструкции для Codex',
  '',
  'Тот же проект, но файл свой: у каждого CLI он называется по-своему.',
  '',
  '- Отвечать по-русски.',
  '- Правки точечные.',
  '',
].join('\n');

/** Метка времени в имени копии: ISO, где `:` и `.` заменены на `-`. */
function stamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

/** Псевдослучайное с зашитым зерном: числа отчёта не должны прыгать между съёмками. */
function rng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Write', 'Task', 'WebFetch'];

/**
 * Транскрипты за последние 30 суток. Один файл — одна сессия, строка — один
 * ответ модели с приложенным `usage`, ровно как их пишет Claude Code.
 */
function writeTranscripts(root) {
  const random = rng(20260911);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  for (const [index, project] of PROJECTS.entries()) {
    const dir = join(root, 'projects', project.dir);
    mkdirSync(dir, { recursive: true });

    for (let day = 29; day >= 0; day -= 1) {
      // У второго проекта работа не каждый день: в ряду по дням должны быть и
      // провалы, иначе график читается как ровная полка.
      if (index === 1 && day % 3 === 0) continue;

      const sessionId = `s${index}${String(day).padStart(2, '0')}-${1000 + day}`;
      const lines = [];
      const responses = 6 + Math.floor(random() * 8);
      let lastAt = midnight.getTime() - day * 86_400_000;

      for (let n = 0; n < responses; n += 1) {
        const at = new Date(midnight.getTime() - day * 86_400_000);
        at.setHours(9 + Math.floor(random() * 10), Math.floor(random() * 60), 0, 0);
        lastAt = Math.max(lastAt, at.getTime());
        const content = [{ type: 'text' }];
        const toolCalls = Math.floor(random() * 4);
        for (let k = 0; k < toolCalls; k += 1) {
          content.push({ type: 'tool_use', name: TOOLS[Math.floor(random() * TOOLS.length)] });
        }

        lines.push(
          JSON.stringify({
            type: 'assistant',
            timestamp: at.toISOString(),
            sessionId,
            requestId: `req-${index}-${day}-${n}`,
            cwd: project.path,
            gitBranch: project.branch,
            message: {
              id: `msg-${index}-${day}-${n}`,
              model: MODELS[Math.floor(random() * MODELS.length)],
              content,
              usage: {
                input_tokens: 180 + Math.floor(random() * 1400),
                output_tokens: 240 + Math.floor(random() * 2600),
                cache_read_input_tokens: 18_000 + Math.floor(random() * 160_000),
                cache_creation_input_tokens: 1400 + Math.floor(random() * 26_000),
                cache_creation: {
                  ephemeral_5m_input_tokens: 200 + Math.floor(random() * 900),
                  ephemeral_1h_input_tokens: 1200 + Math.floor(random() * 25_000),
                },
              },
            },
          }),
        );
      }

      const file = join(dir, `${sessionId}.jsonl`);
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      // Сессия считается идущей по времени файла, а не по меткам внутри: окно
      // десять минут. Только что записанные файлы дали бы «идёт сейчас» у всех
      // пятидесяти сессий разом — поймано первой съёмкой. Поэтому время файла
      // ставится по его последней записи, и живой оставлена ровно одна.
      const live = index === 0 && day === 0;
      const at = live ? new Date(Date.now() - 2 * 60_000) : new Date(lastAt);
      utimesSync(file, at, at);
    }
  }
}

/** Копии файлов конфигурации: из них история собирает ленту и считает дифф. */
function writeBackups(root) {
  const dir = join(root, 'agentdeck', 'backups');
  mkdirSync(dir, { recursive: true });

  // Время файла ставится по метке из имени: обзор берёт дату последней копии со
  // свойств файла, а лента истории разбирает имя — расходиться они не должны.
  const put = (base, iso, text) => {
    const file = join(dir, `${base}.${stamp(iso)}.bak`);
    writeFileSync(file, text, 'utf8');
    const at = new Date(iso);
    utimesSync(file, at, at);
  };

  put('CLAUDE.md', '2026-09-08T09:12:40.120Z', CLAUDE_MD_OLDEST);
  put('CLAUDE.md', '2026-09-09T14:05:33.400Z', CLAUDE_MD_PREVIOUS);
  // Самая свежая копия сравнивается с ТЕКУЩИМ файлом: её дифф и есть то, что
  // можно вернуть по кускам. Поэтому в ней предыдущая редакция, а не нынешняя.
  put('CLAUDE.md', '2026-09-10T18:41:07.900Z', CLAUDE_MD_PREVIOUS);
  put(
    'settings.json',
    '2026-09-09T11:27:15.050Z',
    `${JSON.stringify(previousSettings(root), null, 2)}\n`,
  );
  put('.claude.json', '2026-09-07T16:03:52.700Z', `${JSON.stringify(MCP_CONFIG, null, 2)}\n`);
}

/**
 * Собрать каталог конфигурации целиком и вернуть пути.
 *
 * Корень вложен в свою папку (`<tmp>/.claude`) намеренно: регистрация
 * MCP-серверов лежит РЯДОМ с каталогом (`../.claude.json`), и без вложенности
 * она уехала бы во временный каталог системы, к чужим файлам.
 */
export function buildFixture(home) {
  const root = join(home, '.claude');
  mkdirSync(join(root, 'agentdeck'), { recursive: true });

  writeFileSync(join(root, 'CLAUDE.md'), CLAUDE_MD, 'utf8');
  healHook(root);
  writeFileSync(join(home, '.claude.json'), `${JSON.stringify(MCP_CONFIG, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(root, '.mcp-secrets.env'),
    `# Ключ витрины: выдаётся в админке магазина\nSHOP_API_TOKEN=${DEMO_VALUE}\n`,
    'utf8',
  );

  for (const skill of SKILLS) {
    const dir = join(root, skill.enabled ? 'skills' : 'skills-disabled', skill.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\n# ${skill.id}\n\n${skill.body}\n`,
      'utf8',
    );
  }

  mkdirSync(join(root, 'hooks'), { recursive: true });
  for (const script of SCRIPTS) {
    writeFileSync(join(root, 'hooks', script.name), script.body, 'utf8');
  }

  writeTranscripts(root);
  writeBackups(root);

  // Каталог назван `.codex`, как у настоящего CLI: путь к файлу каждой стороны
  // пишет на кадре сервер, и подмена корня на домашний каталог человека должна
  // давать ровно тот путь, который он увидит у себя.
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), CODEX_CONFIG_TOML, 'utf8');
  writeFileSync(join(codexHome, 'AGENTS.md'), CODEX_AGENTS_MD, 'utf8');

  return { root, codexHome };
}

/**
 * Сломать один хук: скрипт, которого нет на диске. Нужен «тревожному» кадру
 * обзора — плитка хуков краснеет только когда такой хук действительно есть.
 */
export function breakHook(root) {
  const missing = `node "${join(root, 'hooks', 'warm-cache.mjs').replace(/\\/g, '/')}"`;
  const broken = withHooks(root, {
    SessionStart: [{ hooks: [{ type: 'command', command: missing }] }],
  });
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(broken, null, 2)}\n`, 'utf8');
}

/** Вернуть settings.json к исправному виду: следующий сценарий снимает здоровую панель. */
export function healHook(root) {
  writeFileSync(
    join(root, 'settings.json'),
    `${JSON.stringify(withHooks(root), null, 2)}\n`,
    'utf8',
  );
}
