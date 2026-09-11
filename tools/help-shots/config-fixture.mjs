/**
 * Обстановка для пачки «Настройка поведения»: скиллы, команды, хуки, скрипты,
 * плагины. Одноразовый каталог конфигурации, который панель читает и правит
 * по-настоящему.
 *
 * Предмет этих пяти разделов — файлы, а не ответы сервера, поэтому подменять
 * здесь почти нечего: панель разбирает настоящий `SKILL.md`, настоящую секцию
 * `hooks` в settings.json и настоящие файлы из `hooks/`. Меняется только то,
 * КАКОЙ каталог она читает — `CLAUDE_CONFIG_DIR` уводится в отдельную папку.
 * Личный `~/.claude` владельца машины не читается и не правится ни на шаг.
 *
 * ПОЧЕМУ КАТАЛОГ НЕ ВО ВРЕМЕННОЙ ПАПКЕ СИСТЕМЫ. Раздел «Хуки» показывает
 * команду запуска целиком, а на Windows временная папка лежит внутри профиля
 * пользователя — в кадр уехало бы настоящее имя человека. Каталог создаётся
 * рядом с репозиторием, помечается файлом-меткой и сносится в конце; метка не
 * даёт снести чужую папку, если имя совпало.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Куда кладётся одноразовый каталог конфигурации. Имени человека в нём нет. */
export const HOME_DIR = 'C:/work/claude-help-config';

/** Куда кладётся выдуманная папка для каркаса плагина. */
export const PLUGINS_DIR = 'C:/work/claude-help-plugins';

/** Метка «каталог создан съёмкой» — без неё чужая папка не сносится. */
const MARK = '.help-shots-owned';

/** Записать файл, создав недостающие папки. */
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Записать JSON с переводом строки в конце — так же, как это делает панель. */
function putJson(path, value) {
  put(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ── Скиллы ──────────────────────────────────────────────────────────────────

/** Скилл одним файлом: только frontmatter и тело. */
function skillFile(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

const SKILLS = [
  {
    id: 'code-review',
    name: 'code-review',
    description:
      'Use КОГДА просят разобрать чужой код, посмотреть правки перед отправкой ' +
      'или объяснить, почему решение спорное.',
    body:
      '# Разбор кода\n\n## Что делать\n\n1. Прочитать правку целиком, а не по кускам.\n' +
      '2. Назвать каждое замечание местом в файле и строкой.\n' +
      '3. Отделить «сломано» от «мне бы иначе».\n\n## Чего не делать\n\n' +
      'Не переписывать за автора и не спорить о стиле там, где есть форматтер.\n',
    files: [],
  },
  {
    id: 'release-notes',
    name: 'release-notes',
    description:
      'Use КОГДА просят собрать описание релиза, список изменений или текст ' +
      'для задачи по готовым коммитам.',
    body:
      '# Описание релиза\n\n## Когда применять\n\nПеред отправкой ветки, когда нужен ' +
      'связный текст, а не список коммитов.\n\n## Шаги\n\n1. Сгруппировать правки по смыслу.\n' +
      '2. Для каждой группы — что изменилось и почему.\n3. Сверить с образцами в `references/`.\n',
    files: [
      [
        'references/format.md',
        '# Формат\n\nОдин абзац на изменение: что стало иначе, для кого это заметно.\n' +
          'Ни слова о том, как шла работа.\n',
      ],
      [
        'references/examples.md',
        '# Образцы\n\n- Хорошо: «Список правил больше не пустеет при промахе поиска».\n' +
          '- Плохо: «Поправил баг в компоненте».\n',
      ],
    ],
  },
  {
    id: 'perf-audit',
    name: 'perf-audit',
    description: 'Use КОГДА жалуются на медленную страницу или просят найти, что тормозит.',
    body:
      '# Разбор скорости\n\n## Порядок\n\n1. Измерить до правки.\n2. Найти самое дорогое место.\n' +
      '3. Поправить одно и измерить снова.\n',
    files: [],
  },
];

/** Скилл, лежащий в `skills-disabled/`: в палитре его нет, в списке он есть. */
const DISABLED_SKILL = {
  id: 'db-migrations',
  name: 'db-migrations',
  description: 'Use КОГДА просят изменить схему базы или написать миграцию.',
  body: '# Миграции\n\nПравило простое: схема меняется только задачей, никогда — по ходу дела.\n',
};

// ── Файлы команд ────────────────────────────────────────────────────────────

const COMMAND_FILES = [
  [
    'deploy.md',
    '---\ndescription: Выкатить ветку на стенд проверки\nargument-hint: "<ветка>"\n---\n\n' +
      'Собрать ветку и выложить её на стенд проверки. Ничего не сливать.\n',
  ],
  [
    'git/commit.md',
    '---\ndescription: Собрать коммит из текущих правок\n---\n\n' +
      'Показать, что изменилось, предложить текст сообщения и дождаться ответа.\n',
  ],
  [
    'git/mr.md',
    '---\ndescription: Черновик описания для запроса на слияние\n---\n\n' +
      'Описание пишется про изменение, а не про то, как шла работа.\n',
  ],
];

// ── Скрипты в hooks/ ────────────────────────────────────────────────────────

const SCRIPT_FILES = [
  [
    'destructive-guard.mjs',
    `/**
 * Не пропускает разрушительные команды: сверяет строку запуска со списком и
 * требует подтверждения человека.
 */
import { readInput } from './shared/input.mjs';

const PATTERNS = ['rm -rf', 'DROP TABLE', 'TRUNCATE', 'kubectl delete'];
const input = await readInput();
const command = String(input?.tool_input?.command ?? '');

const hit = PATTERNS.find((pattern) => command.includes(pattern));
if (hit) {
  console.error(\`Опасная операция («\${hit}») — подтвердите вручную.\`);
  process.exit(2);
}
`,
  ],
  [
    'secret-guard.mjs',
    `/**
 * Проверяет запись файлов на строки, похожие на ключи и токены.
 */
import { readInput } from './shared/input.mjs';

const MARKERS = ['glpat-', 'ghp_', 'AKIA', '-----BEGIN'];
const input = await readInput();
const text = String(input?.tool_input?.content ?? '');

if (MARKERS.some((marker) => text.includes(marker))) {
  console.error('Похоже на секрет в тексте файла — запись остановлена.');
  process.exit(2);
}
`,
  ],
  [
    'format-on-edit.mjs',
    `/**
 * Прогоняет форматтер по файлу, который только что правили.
 */
import { spawnSync } from 'node:child_process';
import { readInput } from './shared/input.mjs';

const input = await readInput();
const file = String(input?.tool_input?.file_path ?? '');
if (file) spawnSync('npx', ['prettier', '--write', file], { stdio: 'inherit' });
`,
  ],
  [
    'session-brief.mjs',
    `/**
 * Краткая сводка в начале сессии: ветка, незакрытые правки, где лежат заметки.
 */
import { execFileSync } from 'node:child_process';

const branch = execFileSync('git', ['branch', '--show-current']).toString().trim();
console.log(JSON.stringify({ additionalContext: \`Ветка: \${branch}. Заметки: .agent/notes.md\` }));
`,
  ],
  [
    'shared/input.mjs',
    `/**
 * Разбор входных данных хука: Claude Code передаёт их одним JSON на stdin.
 * Общий модуль — его импортируют все скрипты рядом.
 */
export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
`,
  ],
  [
    'notify.ps1',
    `<#
  Всплывающее уведомление на рабочем столе. Запускается руками, ни к какому
  событию не привязан.
#>
param([string]$Text = 'Готово')
[System.Windows.Forms.MessageBox]::Show($Text)
`,
  ],
  [
    'guards.test.mjs',
    `/**
 * Проверка стражей: подкладывает строку запуска и ждёт код возврата 2.
 */
import { test } from 'node:test';

test('страж ловит rm -rf', () => {
  // проверка живёт рядом со скриптом, который проверяет
});
`,
  ],
];

// ── Хуки в settings.json ────────────────────────────────────────────────────

/** Команда запуска скрипта из каталога конфигурации — абсолютным путём. */
function runScript(home, name) {
  return `node "${home}/hooks/${name}"`;
}

/**
 * Секция `hooks` личного settings.json: событие → группы фильтра → команды.
 * Последний хук намеренно ссылается на файл, которого в `hooks/` нет, — раздел
 * обязан назвать это красной пометкой, а не промолчать.
 */
function hooksSection(home) {
  return {
    PreToolUse: [
      {
        matcher: 'Bash|PowerShell',
        hooks: [{ type: 'command', command: runScript(home, 'destructive-guard.mjs') }],
      },
      {
        matcher: 'Write|Edit',
        hooks: [{ type: 'command', command: runScript(home, 'secret-guard.mjs'), timeout: 10 }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Write|Edit',
        hooks: [{ type: 'command', command: runScript(home, 'format-on-edit.mjs') }],
      },
      {
        matcher: 'Write',
        hooks: [{ type: 'command', command: runScript(home, 'lint-on-edit.mjs') }],
      },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: runScript(home, 'session-brief.mjs') }] }],
  };
}

// ── Плагины ─────────────────────────────────────────────────────────────────

/**
 * Реестр установленного: тот самый `plugins/installed_plugins.json`, который
 * читает и CLI, и раздел «Команды». Версия 2 — единственная, которую CLI
 * признаёт; на другой команды плагинов в палитру не попадают.
 */
function pluginRegistry(root, { version = 2 } = {}) {
  return {
    version,
    plugins: {
      'code-review@team-tools': [{ installPath: `${root}/plugins/repos/team-tools/code-review` }],
      'sql-helper@team-tools': [{ installPath: `${root}/plugins/repos/team-tools/sql-helper` }],
    },
  };
}

/** Файлы установленных плагинов: команда и скилл, как их раскладывает CLI. */
function writePluginFiles(root) {
  const base = join(root, 'plugins', 'repos', 'team-tools');
  put(
    join(base, 'code-review', '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'code-review', version: '1.4.0' }, null, 2)}\n`,
  );
  put(
    join(base, 'code-review', 'commands', 'review.md'),
    '---\ndescription: Разобрать правки ветки по шагам команды\n---\n\nПорядок разбора.\n',
  );
  put(
    join(base, 'code-review', 'skills', 'review-checklist', 'SKILL.md'),
    skillFile(
      'review-checklist',
      'Use КОГДА нужен чеклист перед отправкой ветки на разбор.',
      '# Чеклист\n\n- [ ] Тесты зелёные\n- [ ] Описание про изменение\n',
    ),
  );
  put(
    join(base, 'sql-helper', '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'sql-helper', version: '0.9.2' }, null, 2)}\n`,
  );
  put(
    join(base, 'sql-helper', 'commands', 'explain.md'),
    '---\ndescription: Объяснить план запроса и назвать узкое место\n---\n\nРазбор плана.\n',
  );
}

/** Подключённые маркетплейсы: файл рядом с реестром, его читает сама панель. */
function marketplaces() {
  return {
    'team-tools': { source: 'team-tools/claude-plugins', installLocation: 'plugins/repos' },
    'lab-kit': { source: 'lab-kit/plugins', installLocation: 'plugins/repos' },
  };
}

// ── Сборка ──────────────────────────────────────────────────────────────────

/**
 * Создать одноразовый каталог конфигурации со всей обстановкой пачки.
 *
 * `onboardingDone` ставится сразу: мастер первого запуска — отдельный экран, и
 * в кадрах этой пачки ему делать нечего. Светлая тема выбрана явно, чтобы кадры
 * не зависели от темы машины, на которой идёт съёмка.
 */
export function makeHome(home = HOME_DIR) {
  if (existsSync(home) && !existsSync(join(home, MARK))) {
    throw new Error(`${home} уже существует и создан не съёмкой — выберите другой путь`);
  }
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  put(join(home, MARK), 'создан tools/help-shots/config-panel.mjs\n');

  putJson(join(home, 'settings.json'), {
    hooks: hooksSection(home),
    enabledPlugins: { 'code-review@team-tools': true },
  });
  // Локальный файл настроек: его хуки панель показывает, но не правит.
  putJson(join(home, 'settings.local.json'), {
    hooks: {
      SessionEnd: [
        {
          hooks: [{ type: 'command', command: `node "${home}/hooks/session-close.mjs"` }],
        },
      ],
    },
  });
  put(
    join(home, 'CLAUDE.md'),
    '# Личные правила\n\n## ПРАВИЛО: Язык общения\n\nОтвечать по-русски.\n',
  );
  putJson(join(home, 'agentdeck', 'state.json'), {
    projects: [],
    settings: { onboardingDone: true, theme: 'light', language: 'ru' },
  });

  setSkills(home);
  for (const [name, text] of COMMAND_FILES) put(join(home, 'commands', name), text);
  for (const [name, text] of SCRIPT_FILES) put(join(home, 'hooks', name), text);

  putJson(join(home, 'plugins', 'installed_plugins.json'), pluginRegistry(home));
  putJson(join(home, 'plugins', 'known_marketplaces.json'), marketplaces());
  writePluginFiles(home);

  return home;
}

/** Разложить скиллы заново: включённые в `skills/`, выключенный — рядом. */
export function setSkills(home, { enabled = SKILLS, disabled = [DISABLED_SKILL] } = {}) {
  rmSync(join(home, 'skills'), { recursive: true, force: true });
  rmSync(join(home, 'skills-disabled'), { recursive: true, force: true });
  mkdirSync(join(home, 'skills'), { recursive: true });

  for (const [dir, list] of [
    ['skills', enabled],
    ['skills-disabled', disabled],
  ]) {
    for (const skill of list) {
      put(
        join(home, dir, skill.id, 'SKILL.md'),
        skillFile(skill.name, skill.description, skill.body),
      );
      for (const [file, text] of skill.files ?? []) put(join(home, dir, skill.id, file), text);
    }
  }
}

/** Убрать все скиллы — состояние «в разделе пусто», с которого начинают все. */
export function clearSkills(home) {
  setSkills(home, { enabled: [], disabled: [] });
}

/**
 * Убрать хуки из обоих файлов настроек — состояние «раздел пуст».
 * Локальный файл чистится вместе с личным: одна оставшаяся в нём запись
 * показала бы карточку там, где по смыслу кадра должна быть заглушка.
 */
export function clearHooks(home) {
  putJson(join(home, 'settings.json'), { enabledPlugins: { 'code-review@team-tools': true } });
  putJson(join(home, 'settings.local.json'), {});
}

/** Вернуть хуки на место — и личные, и запись локального файла настроек. */
export function restoreHooks(home) {
  putJson(join(home, 'settings.json'), {
    hooks: hooksSection(home),
    enabledPlugins: { 'code-review@team-tools': true },
  });
  putJson(join(home, 'settings.local.json'), {
    hooks: {
      SessionEnd: [
        { hooks: [{ type: 'command', command: `node "${home}/hooks/session-close.mjs"` }] },
      ],
    },
  });
}

/** Переписать реестр плагинов с чужой версией — CLI такой реестр не читает. */
export function setPluginRegistryVersion(home, version) {
  putJson(join(home, 'plugins', 'installed_plugins.json'), pluginRegistry(home, { version }));
}

/** Папка, в которой снимается каркас плагина: настоящая, пустая, помеченная. */
export function makePluginsDir(dir = PLUGINS_DIR) {
  if (existsSync(dir) && !existsSync(join(dir, MARK))) {
    throw new Error(`${dir} уже существует и создан не съёмкой — выберите другой путь`);
  }
  mkdirSync(dir, { recursive: true });
  put(join(dir, MARK), 'создан tools/help-shots/config-panel.mjs\n');
  return dir;
}

/** Снести созданное съёмкой — но только то, на чём стоит метка. */
export function drop(dir) {
  if (existsSync(join(dir, MARK))) rmSync(dir, { recursive: true, force: true });
}
