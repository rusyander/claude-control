/**
 * Круговой инвариант переноса среды (П2.1): канон → запись → импорт → канон′.
 *
 * Эмиттер проверяется НЕ по тому, что он сам о себе сообщает. Паспорт
 * раскладывается по домам всех десяти CLI настоящими адаптерами, а потом каждый
 * дом читается НАСТОЯЩИМ импортёром этого CLI — и запись обязана найтись у цели
 * той же записью. Совпадение плана с самим собой доказало бы план; здесь
 * доказывается файл.
 *
 * Чем это отличается от `emit.test.ts` рядом. Юниты держат по одному свойству
 * каждый (текст человека цел, копии нет, второй прогон не раздваивает). Эта
 * проверка — единственное место, где обе половины партии, импорт и эмиссия,
 * сходятся на одном паспорте: разошлись имена, потерялся ключ, уехал секрет —
 * красный здесь, а не у человека в чужом доме.
 *
 * ДЕГРАДАЦИИ ОБЪЯВЛЕНЫ СПИСКОМ (`DECLARED`). Несовпадение вне списка валит
 * проверку — это и есть критерий приёмки волны. Список сокращается правкой кода,
 * а не дописыванием строки: каждая его запись называет причину и тикет.
 *
 * Уровень верности здесь НЕ пересчитывается: чего ждать от цели, говорит приговор
 * матрицы (П1), вынесенный тем же `fidelity.ts`. Н — запись обязана найтись у
 * цели своим видом; Т — её текст обязан оказаться в инструкциях цели; остальное
 * держится рантаймом и файла не касается.
 *
 * Запуск: `node tools/qa/check-portability-roundtrip.mjs`
 * Самопроверка: `node tools/qa/check-portability-roundtrip.mjs --selftest` —
 * портит канон цели по каждой статье и требует, чтобы проверка покраснела ИМЕННО
 * на ней. Проверка, которая не может покраснеть, — украшение.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Значение-маркер: доехало до файла цели — проверка обязана покраснеть. */
const SECRET_VALUE = 'sk-ant-МАРКЕР-7c2f5e18-НЕ-ДОЛЖЕН-УТЕЧЬ';

/** Текст человека в чужом файле: перенос обязан оставить его дословно. */
const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';

/** Вложение скилла: файл внутри его каталога обязан доехать до цели байт в байт. */
const ATTACHMENT_TEXT = 'Справка скилла: перенос обязан довезти её файлом.\n';

/** След настоящего запуска скрипта хука: файл с этим текстом пишет сам скрипт. */
const HOOK_MARK = 'хук исполнился';

/** Плагин источника: его содержимое едет обычными записями с пометкой (П2.6). */
const PLUGIN_ID = 'review@agentdeck-qa';

const selftest = process.argv.includes('--selftest');
const home = mkdtempSync(join(tmpdir(), 'portability-roundtrip-'));

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

/**
 * ОБЪЯВЛЕННЫЕ деградации кругового переноса.
 *
 * Здесь только то, что теряется ПО РЕШЕНИЮ, с причиной и местом, где решение
 * записано. Всё прочее расхождение — брак.
 */
const DECLARED = [
  {
    kind: 'mcpServer',
    what: 'значения переменных окружения сервера',
    why: 'инвариант 5: секрет не ложится на диск чужого CLI; ключи доедут окружением запуска (П3.5)',
  },
  {
    kind: 'secret',
    what: 'секреты целиком',
    why: 'инвариант 5: значения канон не носит вовсе, записывать нечего',
  },
  {
    kind: 'permission',
    partial: true,
    what: 'режим подтверждений целого CLI (`mode:*`)',
    why: 'permissions-map.ts, решение 3: настройка всего ассистента правилом не записывается, и переставлять чужую глобальную строгость перенос не станет',
  },
  {
    kind: 'permission',
    partial: true,
    what: 'решение, которого у цели нет, ПОНИЖАЕТСЯ в сторону строгости',
    why: 'инвариант 6 плюс `permissionsConfig.decisions`: у cursor и gemini нет списка «спросить», и `ask` доезжает запретом',
  },
  {
    kind: 'permission',
    partial: true,
    what: 'имя инструмента переводится словарём цели, а вне закрытого словаря правило не пишется вовсе',
    why: 'решение владельца 20.09.2026: сочинённое соответствие хуже довезённой строки, а закрытый словарь OpenCode чужого имени не примет',
  },
  {
    kind: 'plugin',
    what: 'плагины',
    why: 'П2.6 — плагин как единица',
  },
  {
    kind: 'panelGroup',
    what: 'группы панели',
    why: 'П6.2 — конструкции панели',
  },
  {
    kind: 'conversation',
    what: 'разговоры',
    why: 'П6.1 — контекст разговоров',
  },
];

/**
 * Объявлена ли потеря записи этого вида ЦЕЛИКОМ.
 *
 * Строка с `partial` вид не освобождает: она называет, что именно внутри вида
 * меняется по решению, а сама запись обязана найтись у цели. Без этой разницы
 * одна объявленная мелочь снимала бы проверку со всего вида — ровно тот способ
 * замолчать потерю, который список деградаций и обязан исключать.
 */
function isDeclared(kind) {
  return DECLARED.some((row) => row.kind === kind && !row.partial);
}

/** Строгость решения числом: чем больше, тем меньше разрешено. */
function strictness(decision) {
  return ['allow', 'ask', 'deny'].indexOf(decision);
}

/**
 * Правило источника в грамматике ЦЕЛИ — считается ЗДЕСЬ, из каталога, а не
 * спрашивается у переноса: проверка, взявшая ответ у проверяемого, сравнивает
 * панель с самой собой.
 */
function expectedRule(provider, rule) {
  const grammar = provider.permissionsConfig?.ruleGrammar;
  const match = /^(.*?)\(([^)]*)\)\s*$/.exec(rule);
  const tool = (match ? match[1] : rule).trim();
  const argument = match ? match[2] : null;
  const renamed = grammar?.tools?.[tool] ?? tool;
  return argument === null ? renamed : `${renamed}(${argument})`;
}

/**
 * Право у цели: доехало ли правило и не ослабло ли решение.
 *
 * Две проверки вместо сравнения записей: строку переводит словарь цели, решение
 * может понизиться до строгого — и ровно эти две свободы объявлены выше. Всё
 * остальное обязано совпасть, а `deny`, ставший `allow`, — брак переноса.
 */
function comparePermission(targetId, provider, entry, item, items) {
  const expected = expectedRule(provider, item.rule);
  const found = items.filter((other) => other.kind === 'permission' && other.rule === expected);

  if (entry.outcome === 'written') {
    check(`${targetId}: право «${item.rule}» доехало до цели как «${expected}»`, found.length > 0);
    for (const rule of found) {
      check(
        `${targetId}: решение права «${expected}» не ослаблено`,
        strictness(rule.decision) >= strictness(item.decision),
        `${item.decision} → ${rule.decision}`,
      );
    }
  }

  if (entry.outcome === 'refused_by_target') {
    check(`${targetId}: отказанное право «${item.rule}» у цели не записано`, found.length === 0);
  }
}

/** Записать файл, создав каталоги по пути. */
function put(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом-ИСТОЧНИК: по разделу на каждый слой, который эта волна возит. */
function writeSource(root) {
  const claude = join(root, '.claude');
  put(
    join(claude, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET_VALUE },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'node ./format.mjs', timeout: 5 }],
          },
        ],
        // Хук с НАСТОЯЩИМ скриптом по абсолютному пути в написании этой ОС:
        // ниже записанная у цели команда запускается оболочкой, и это
        // единственная честная проверка критерия «действительно исполняется».
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `node ${join(claude, 'hooks', 'mark.mjs')}`, timeout: 5 },
            ],
          },
        ],
      },
      enabledPlugins: { [PLUGIN_ID]: true },
    }),
  );
  put(
    join(claude, 'hooks', 'mark.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(process.argv[2], ${JSON.stringify(HOOK_MARK)}, 'utf8');`,
      '',
    ].join('\n'),
  );
  writePlugin(claude);
  put(
    join(claude, 'CLAUDE.md'),
    ['Преамбула источника.', '', '## ПРАВИЛО: По-русски', '', 'Отвечать по-русски.', ''].join('\n'),
  );
  put(
    join(claude, 'skills', 'doc-hygiene', 'SKILL.md'),
    [
      '---',
      'name: doc-hygiene',
      'description: Порядок в документах',
      '---',
      '',
      'Тело скилла.',
      '',
    ].join('\n'),
  );
  // Скилл — это КАТАЛОГ: справка внутри него обязана доехать файлом, а файл
  // крупнее потолка на один файл (1 МиБ) — быть назван по имени, а не «часть не
  // влезла».
  put(join(claude, 'skills', 'doc-hygiene', 'references', 'style.md'), ATTACHMENT_TEXT);
  // Выключенный скилл: у Claude состояние файловое — он лежит в отдельном
  // каталоге и обязан не приехать к цели действующим.
  put(
    join(claude, 'skills-disabled', 'sleeping', 'SKILL.md'),
    ['---', 'name: sleeping', 'description: Спящий скилл', '---', '', 'Спит.', ''].join('\n'),
  );
  put(join(claude, 'skills', 'doc-hygiene', 'references', 'huge.bin'), 'x'.repeat(1024 * 1024 + 1));
  put(
    join(claude, 'commands', 'review.md'),
    ['---', 'description: Ревью изменений', '---', '', 'Посмотри диф.', ''].join('\n'),
  );
  put(
    join(claude, 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: Ревьюер',
      'tools: Read, Grep',
      'disallowedTools: Bash, Write',
      'omitClaudeMd: true',
      '---',
      '',
      'Смотри внимательно.',
      '',
    ].join('\n'),
  );
  // Спутник `.claude.json` лежит РЯДОМ с домашним каталогом, а не внутри него —
  // так его ищет сам CLI (`resolveMcpConfig`). Положенный внутрь, он не
  // прочитался бы вовсе, и проверка молча осталась бы без раздела MCP.
  put(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        files: {
          command: 'npx',
          args: ['-y', 'mcp-files'],
          env: { FILES_TOKEN: SECRET_VALUE },
        },
        // ВТОРОЙ сервер обязателен: у каждой цели оба MCP ложатся в ОДИН файл,
        // и с одним сервером в доме случай «несколько записей одного слоя в один
        // файл» не проверялся ни разу. На настоящем доме (четыре сервера) план
        // падал 500, а круговой прогон этого не видел.
        docs: { command: 'npx', args: ['-y', 'mcp-docs'] },
      },
      // Выключенный сервер лежит в служебном ключе панели и едет записью с
      // `enabled: false`: у цели он обязан быть выключен или не перенесён —
      // и перенос обязан сказать, что именно из двух (П2.6).
      mcpServersDisabled: {
        sleeping: { command: 'npx', args: ['-y', 'mcp-sleeping'] },
      },
    }),
  );
}

/**
 * Плагин Claude: он переносится СОДЕРЖИМЫМ, а не как плагин (П2.6). Скилл и
 * команда внутри обязаны приехать к цели обычными записями с пометкой
 * происхождения — и ровно по одному разу после двух применений плана.
 */
function writePlugin(claude) {
  const installed = join(claude, 'plugins', 'repos', 'review');
  put(
    join(claude, 'plugins', 'installed_plugins.json'),
    // `version: 2` — тот же реестр, что читает сам CLI: иначе записи плагина
    // законно выпадают из паспорта, и проверка ниже искала бы их зря.
    JSON.stringify({
      version: 2,
      plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: installed }] },
    }),
  );
  put(
    join(installed, 'skills', 'plugin-review', 'SKILL.md'),
    [
      '---',
      'name: plugin-review',
      'description: Разбор из плагина',
      '---',
      '',
      'Из плагина.',
      '',
    ].join('\n'),
  );
  put(
    join(installed, 'commands', 'plugin-check.md'),
    ['---', 'description: Проверка из плагина', '---', '', 'Проверь из плагина.', ''].join('\n'),
  );
}

/** Соседние записи в домах целей: они обязаны пережить перенос по значению. */
function writeNeighbours(root) {
  put(join(root, '.codex', 'AGENTS.md'), `${HUMAN_TEXT}\n`);
  put(
    join(root, '.codex', 'config.toml'),
    ['model = "o3"', '', '[mcp_servers.neighbour]', 'command = "мой-сервер"', ''].join('\n'),
  );
  put(join(root, '.gemini', 'GEMINI.md'), `${HUMAN_TEXT}\n`);
  put(
    join(root, '.gemini', 'settings.json'),
    JSON.stringify({ theme: 'мой', mcpServers: { neighbour: { command: 'мой-сервер' } } }),
  );
}

/**
 * Дом ЦЕЛИ для Claude — отдельный каталог: перенос в свой же CLI бывает «на
 * другую машину», и там всё обязано доехать записями, а не оказаться на месте
 * потому, что источник и цель — один каталог.
 */
function overrideOf(providerId) {
  return providerId === 'claude' ? join(home, '.claude-target') : undefined;
}

/**
 * Опознаватель записи: по нему она ищется у цели.
 *
 * Команда хука сравнивается в ОДНОМ написании: путь скрипта уезжает к цели с
 * прямой косой даже на Windows (обратную съедает всякая оболочка семейства sh),
 * и посимвольное сравнение объявило бы потерей ровно то переписывание, которого
 * критерий П2.6 и требует.
 */
function identityOf(item) {
  if (item.kind === 'instructions') return item.text.trim();
  if (item.kind === 'hook') return item.command.split('\\').join('/');
  return item.name ?? item.id;
}

/** Нашлась ли запись у цели своим видом. */
function foundNative(items, item) {
  const identity = identityOf(item);
  if (item.kind === 'instructions') {
    return items.some((other) => other.kind === 'instructions' && other.text.includes(identity));
  }
  return items.some((other) => other.kind === item.kind && identityOf(other) === identity);
}

/** Оказался ли текст записи в инструкциях цели — исход уровня «текстом». */
function foundAsText(items, item) {
  const needle = textNeedleOf(item);
  return items.some((other) => other.kind === 'instructions' && other.text.includes(needle));
}

/**
 * Кусок записи, который обязан найтись в инструкциях цели. Берётся тело, а не
 * заголовок: заголовок пишет сам перенос, и проверка по нему сравнивала бы
 * панель с самой собой.
 */
function textNeedleOf(item) {
  switch (item.kind) {
    case 'instructions':
      return item.text.trim();
    case 'skill':
      return item.body.trim();
    case 'command':
      return item.prompt.trim();
    case 'hook':
      return item.command;
    default:
      return item.intent;
  }
}

/**
 * Сверить один перенос: план, файлы цели, канон цели.
 *
 * Ожидание берётся из ПРИГОВОРА записи, а не из вида: `native` обязан найтись у
 * цели своим видом, `text` — текстом в инструкциях. Остальное держится рантаймом
 * и диска не касается вовсе.
 */
function compare(targetId, plan, items, provider) {
  for (const entry of plan.entries) {
    const item = source.items.find((candidate) => candidate.id === entry.itemId);
    if (!item) {
      failures.push(`${targetId}: строка плана о записи «${entry.itemId}», которой нет в каноне`);
      continue;
    }
    if (isDeclared(item.kind)) continue;

    // Право, доехавшее ПРАВИЛОМ, сравнивается по существу, а не по опознавателю:
    // строка переведена словарём цели, а решение могло понизиться в сторону
    // строгости. Право, доехавшее ТЕКСТОМ (у цели со скалярным режимом правила
    // записать некуда), проверяется общей проверкой текста ниже.
    const asRule = entry.verdict.level === 'native' || entry.outcome === 'refused_by_target';
    if (item.kind === 'permission' && provider && asRule) {
      comparePermission(targetId, provider, entry, item, items);
      continue;
    }

    if (entry.outcome === 'written' && entry.verdict.level === 'native') {
      check(
        `${targetId}: запись «${identityOf(item)}» (${item.kind}) доехала до цели`,
        foundNative(items, item),
      );
    }
    if (entry.outcome === 'written' && entry.verdict.level === 'text') {
      check(
        `${targetId}: запись «${identityOf(item)}» (${item.kind}) доехала текстом`,
        foundAsText(items, item),
      );
    }
  }

  // Секрет не ложится на диск ни при каком исходе — это инвариант 5, а не
  // свойство отдельного вида, поэтому спрашивается у ФАЙЛОВ, а не у канона.
  for (const write of plan.writes) {
    let text;
    try {
      text = readFileSync(write.filePath, 'utf8');
    } catch {
      failures.push(`${targetId}: файл ${write.filePath} не записан`);
      continue;
    }
    check(
      `${targetId}: значение секрета не попало в ${write.filePath}`,
      !text.includes(SECRET_VALUE),
    );
  }

  // Значения переменных сервера — объявленная деградация, и объявлена она в одну
  // сторону: ключи доезжают, значения нет. Пустой список ключей означал бы, что
  // потеряны и ключи тоже, а это уже не деградация, а потеря записи.
  for (const server of items.filter((item) => item.kind === 'mcpServer')) {
    check(
      `${targetId}: у сервера «${server.name}» нет значений переменных`,
      !JSON.stringify(server).includes(SECRET_VALUE),
    );
  }
}

/**
 * Вложения скилла (П2.6): скилл — это КАТАЛОГ, и справка внутри него обязана
 * доехать файлом. Спрашивается у КАНОНА ЦЕЛИ, снятого с её диска: список
 * вложений там собран обходом каталога цели, а не переписан из плана.
 */
function checkAttachments(targetId, round) {
  for (const entry of round.plan.entries) {
    if (entry.kind !== 'skill' || entry.outcome !== 'written') continue;
    // Только там, где скилл доехал СВОИМ видом: у цели без раздела скиллов он
    // доезжает текстом в инструкциях, и файлам вложений лечь там некуда —
    // это свойство уровня «текстом», а не потеря вложения.
    if (entry.verdict.level !== 'native') continue;
    const item = source.items.find((candidate) => candidate.id === entry.itemId);
    if (!item || item.attachments.length === 0) continue;

    const arrived = round.items.find((other) => other.kind === 'skill' && other.name === item.name);
    for (const attachment of item.attachments) {
      const found = arrived?.attachments?.find((other) => other.path === attachment.path);
      check(
        `${targetId}: вложение «${attachment.path}» скилла «${item.name}» доехало до цели`,
        Boolean(found),
      );
      if (found) {
        check(
          `${targetId}: вложение «${attachment.path}» доехало тем же содержимым`,
          found.sha256 === attachment.sha256,
        );
      }
    }
  }
}

/**
 * Потолок вложений: то, что в него не влезло, названо ПОИМЁННО и с причиной.
 * «Часть не влезла» — это не ответ: человек не узнает, чего у цели не будет.
 */
function checkAttachmentCap(items) {
  const skipped = items
    .filter((item) => item.kind === 'skill')
    .flatMap((item) => item.attachmentsSkipped ?? []);

  check(
    'файл сверх потолка назван по имени',
    skipped.some((skip) => skip.path.endsWith('huge.bin')),
  );
  check(
    'у каждого невлезшего вложения названа причина и размер',
    skipped.length > 0 && skipped.every((skip) => skip.reason && typeof skip.bytes === 'number'),
  );
}

/**
 * Состояние вкл/выкл (П2.6): выключенная у источника запись обязана быть у цели
 * выключенной ЛИБО не перенесённой — и перенос обязан сказать, что из двух.
 */
function checkDisabledState(targetId, round, from = source) {
  for (const item of from.items) {
    if (item.enabled !== false) continue;
    const entry = round.plan.entries.find((row) => row.itemId === item.id);
    if (!entry) continue;

    const arrived = round.items.filter(
      (other) => other.kind === item.kind && identityOf(other) === identityOf(item),
    );
    const offAtTarget = arrived.length > 0 && arrived.every((other) => other.enabled === false);
    check(
      `${targetId}: выключенная запись «${identityOf(item)}» (${item.kind}) не приехала действующей`,
      entry.outcome !== 'written' || offAtTarget,
      `исход «${entry.outcome}», у цели записей ${arrived.length}`,
    );
    // Сказано ли, ЧТО ИМЕННО из двух. Спрашивается только там, где механизм у
    // цели есть: запись, не поехавшая по другой причине (раздела нет, держится
    // рантаймом), называет свою причину, а не состояние выключателя.
    if (entry.verdict.level === 'native' && entry.outcome !== 'written') {
      check(
        `${targetId}: про невезённую выключенную запись «${identityOf(item)}» сказано, что она выключена у источника`,
        entry.outcome === 'disabled_at_source',
        entry.outcome,
      );
    }
  }
}

/**
 * Записи из плагина (П2.6): плагин едет содержимым, содержимое помечено
 * происхождением, и второе применение плана не создаёт его второй раз
 * (инвариант 10).
 */
function checkPluginOrigin(targetId, round) {
  for (const item of source.items) {
    if (!item.source.plugin || item.kind === 'plugin') continue;
    const entry = round.plan.entries.find((row) => row.itemId === item.id);
    if (!entry || entry.outcome !== 'written' || entry.verdict.level !== 'native') continue;

    const arrived = round.items.filter(
      (other) => other.kind === item.kind && identityOf(other) === identityOf(item),
    );
    check(
      `${targetId}: запись «${identityOf(item)}» (${item.kind}) из плагина доехала до цели`,
      arrived.length > 0,
    );
    check(
      `${targetId}: запись «${identityOf(item)}» из плагина не удвоилась вторым применением`,
      arrived.length <= 1,
      `у цели ${arrived.length}`,
    );
  }
}

/**
 * Путь скрипта хука у цели (П2.6): единственная честная проверка написания —
 * ЗАПУСТИТЬ записанную команду оболочкой из чужого рабочего каталога. Скрипты
 * хуков не копируются, поэтому у цели остаётся ссылка на файл источника:
 * относительный путь её не найдёт, а обратную косую оболочка съест.
 *
 * Команда берётся из КАНОНА ЦЕЛИ — то есть перечитана с её диска тем же
 * импортёром, каким её прочтёт сам CLI.
 */
function checkHookExecutable(targetId, round) {
  const hook = round.items.find(
    (item) => item.kind === 'hook' && item.command.includes('mark.mjs'),
  );
  if (!hook) return;

  const marker = join(home, `запуск-${targetId}.txt`);
  const run = spawnSync('sh', ['-c', `${hook.command} "${marker}"`], {
    cwd: home,
    encoding: 'utf8',
  });
  check(
    `${targetId}: записанная команда хука исполнилась`,
    run.status === 0,
    `${hook.command} → ${(run.stderr ?? '').trim()}`,
  );
  check(
    `${targetId}: скрипт хука отработал по записанному пути`,
    existsSync(marker) && readFileSync(marker, 'utf8') === HOOK_MARK,
  );
}

let source;

async function main() {
  writeSource(home);
  writeNeighbours(home);

  const { importEnvironment } = await import(
    new URL('../../apps/server/src/domains/portability/import/index.ts', import.meta.url).href
  );
  const { emitEnvironment, emitterProviderIds } = await import(
    new URL('../../apps/server/src/domains/portability/emit/index.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );

  const providers = [claudeProvider, ...CATALOG_PROVIDERS];
  check('эмиттер заведён у всех десяти', emitterProviderIds().length === 10);

  source = importEnvironment({ provider: claudeProvider, scope: 'global' });
  check('паспорт источника не пуст', source.items.length > 0);
  check(
    'выключенные записи источника приехали в паспорт выключенными',
    ['skill', 'mcpServer'].every((kind) =>
      source.items.some((item) => item.kind === kind && item.enabled === false),
    ),
  );
  check(
    'содержимое плагина помечено происхождением',
    source.items.some((item) => item.kind !== 'plugin' && item.source.plugin === PLUGIN_ID),
  );
  checkAttachmentCap(source.items);

  const rounds = new Map();
  for (const provider of providers) {
    const override = overrideOf(provider.id);
    let plan;
    try {
      plan = emitEnvironment(source, { target: provider, scope: 'global', override });
    } catch (error) {
      failures.push(`${provider.id}: эмиттер бросил — ${error.message}`);
      continue;
    }

    for (const write of plan.writes) write.apply();
    const first = importEnvironment({ provider, scope: 'global', override });

    // Второй прогон того же плана: инвариант 10 требует, чтобы записей у цели
    // не стало больше. Спрашивается это у ЦЕЛИ, а не у байтов файла — вторая
    // запись под другим именем байты тоже изменила бы.
    for (const write of plan.writes) write.apply();
    const second = importEnvironment({ provider, scope: 'global', override });
    check(
      `${provider.id}: повторное применение не добавило записей`,
      second.items.length === first.items.length,
      `${first.items.length} → ${second.items.length}`,
    );

    rounds.set(provider.id, { plan, items: second.items, provider });
  }

  check(
    'соседний сервер Codex цел',
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('neighbour'),
  );
  check(
    'текст человека в AGENTS.md цел',
    readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes(HUMAN_TEXT),
  );

  for (const [id, round] of rounds) {
    compare(id, round.plan, round.items, round.provider);
    checkAttachments(id, round);
    checkDisabledState(id, round);
    checkPluginOrigin(id, round);
    checkHookExecutable(id, round);
  }

  checkHookSectionSwitch({ importEnvironment, emitEnvironment, claudeProvider, providers });

  const report = selftest ? selfcheck(rounds) : null;
  finish(report, rounds);
}

/**
 * Рубильник раздела хуков (П2.6): у Qwen весь раздел гасится одним ключом
 * `disableAllHooks`, и его записи СУЩЕСТВУЮТ, но не исполняются.
 *
 * Случай «выключенный хук» проверяется именно так, а не отметкой панели: у
 * Claude выключенный хук из файла УДАЛЁН (его команду хранит состояние панели),
 * то есть файлового выключателя у него нет вовсе. Дом Qwen здесь уже наполнен
 * переносом выше — рубильник опускается на то, что панель туда же и записала.
 */
function checkHookSectionSwitch({ importEnvironment, emitEnvironment, claudeProvider, providers }) {
  const qwen = providers.find((provider) => provider.id === 'qwen');
  const settingsPath = join(home, '.qwen', 'settings.json');
  if (!qwen || !existsSync(settingsPath)) {
    failures.push('рубильник раздела: дома Qwen после переноса нет');
    return;
  }

  const config = JSON.parse(readFileSync(settingsPath, 'utf8'));
  config.disableAllHooks = true;
  writeFileSync(settingsPath, JSON.stringify(config), 'utf8');

  const off = importEnvironment({ provider: qwen, scope: 'global' });
  const hooks = off.items.filter((item) => item.kind === 'hook');
  check(
    'рубильник раздела опущен на КАЖДУЮ запись хука',
    hooks.length > 0 && hooks.every((hook) => hook.enabled === false),
    `${hooks.filter((hook) => hook.enabled === false).length} из ${hooks.length}`,
  );
  check(
    'выключенный целиком раздел назван состоянием, а не пропуском',
    (off.sectionStates ?? []).some((state) => state.kind === 'hook' && state.enabled === false),
  );

  const override = join(home, '.claude-hooks-off');
  const plan = emitEnvironment(off, { target: claudeProvider, scope: 'global', override });
  for (const write of plan.writes) write.apply();
  const arrived = importEnvironment({ provider: claudeProvider, scope: 'global', override });
  checkDisabledState('claude (рубильник)', { plan, items: arrived.items }, off);
}

/**
 * Самопроверка: канон цели портится по каждой статье, и проверка ОБЯЗАНА
 * покраснеть именно на ней. Счётчик претензий не годится — он не скажет, какая
 * из проверок ослепла.
 */
function selfcheck(rounds) {
  const before = failures.length;
  const missed = [];

  for (const [name, poison, needle, run] of poisons(rounds)) {
    const at = failures.length;
    if (run) run(poison);
    else compare('отравленный', poison.plan, poison.items, poison.provider);
    if (!failures.slice(at).some((failure) => failure.includes(needle))) missed.push(name);
  }

  // Собственные находки самопроверки в итог не идут: она проверяет проверку.
  failures.length = before;
  return { missed };
}

/** Порча по каждой статье: пропавшая запись, потерянный текст, уехавший секрет. */
function poisons(rounds) {
  const round = rounds.get('claude') ?? [...rounds.values()][0];
  // Уровень «текстом» встречается у цели, у которой раздела нет совсем: у
  // Cursor текстом доезжают скиллы и команды. Взять сюда цель, у которой таких
  // записей нет, значило бы кормить проверку пустотой и называть это зелёным.
  const text = rounds.get('cursor') ?? round;
  return [
    [
      'пропавшая у цели запись',
      { plan: round.plan, items: [], provider: round.provider },
      'доехала до цели',
    ],
    [
      'потерянный текст записи',
      {
        plan: text.plan,
        items: text.items.filter((item) => item.kind !== 'instructions'),
        provider: text.provider,
      },
      'доехала текстом',
    ],
    [
      'запись плана о неизвестном каноне',
      {
        plan: { ...round.plan, entries: [{ ...round.plan.entries[0], itemId: 'выдуманная' }] },
        items: round.items,
        provider: round.provider,
      },
      'которой нет в каноне',
    ],
    [
      'ослабленное у цели решение права',
      {
        plan: round.plan,
        items: round.items.map((item) =>
          item.kind === 'permission' ? { ...item, decision: 'allow' } : item,
        ),
        provider: round.provider,
      },
      'не ослаблено',
    ],
    [
      'пропавшее у цели право',
      {
        plan: round.plan,
        items: round.items.filter((item) => item.kind !== 'permission'),
        provider: round.provider,
      },
      'доехало до цели как',
    ],
    [
      'значение секрета у цели',
      {
        plan: round.plan,
        items: round.items.map((item) =>
          item.kind === 'mcpServer' ? { ...item, raw: `TOKEN=${SECRET_VALUE}` } : item,
        ),
        provider: round.provider,
      },
      'нет значений переменных',
    ],
    ...poisonsOfAttachmentsAndState(round),
  ];
}

/**
 * Порча по статьям П2.6: вложения, состояние вкл/выкл, происхождение из плагина
 * и исполнимость записанного пути. Каждая — со своим запуском, потому что эти
 * проверки спрашивают не то же самое, что `compare`.
 */
function poisonsOfAttachmentsAndState(round) {
  const off = source.items.find((item) => item.enabled === false);
  const plugged = source.items.find((item) => item.source.plugin && item.kind !== 'plugin');

  return [
    [
      'потерянное у цели вложение скилла',
      {
        plan: round.plan,
        items: round.items.map((item) =>
          item.kind === 'skill' ? { ...item, attachments: [] } : item,
        ),
      },
      'доехало до цели',
      (poison) => checkAttachments('отравленный', poison),
    ],
    [
      'подменённое содержимое вложения',
      {
        plan: round.plan,
        items: round.items.map((item) =>
          item.kind === 'skill'
            ? {
                ...item,
                attachments: (item.attachments ?? []).map((one) => ({ ...one, sha256: 'другое' })),
              }
            : item,
        ),
      },
      'тем же содержимым',
      (poison) => checkAttachments('отравленный', poison),
    ],
    [
      'невлезшее вложение без имени',
      source.items.map((item) =>
        item.kind === 'skill' ? { ...item, attachmentsSkipped: [] } : item,
      ),
      'назван по имени',
      (poison) => checkAttachmentCap(poison),
    ],
    [
      'выключенная запись, приехавшая действующей',
      {
        plan: {
          ...round.plan,
          entries: round.plan.entries.map((entry) =>
            entry.itemId === off?.id ? { ...entry, outcome: 'written' } : entry,
          ),
        },
        items: off ? [...round.items, { ...off, enabled: true }] : round.items,
      },
      'не приехала действующей',
      (poison) => checkDisabledState('отравленный', poison),
    ],
    [
      'удвоенная у цели запись из плагина',
      {
        plan: round.plan,
        items: plugged ? [...round.items, { ...plugged, id: `${plugged.id}-второй` }] : round.items,
      },
      'не удвоилась',
      (poison) => checkPluginOrigin('отравленный', poison),
    ],
    [
      'неисполнимый путь скрипта у цели',
      {
        plan: round.plan,
        items: round.items.map((item) =>
          item.kind === 'hook' && item.command.includes('mark.mjs')
            ? { ...item, command: `node ${join(home, 'нет', 'mark.mjs')}` }
            : item,
        ),
      },
      'исполнилась',
      (poison) => checkHookExecutable('отравленный', poison),
    ],
  ];
}

function finish(report, rounds) {
  rmSync(home, { recursive: true, force: true });

  if (report) {
    if (report.missed.length > 0) {
      console.error(`Самопроверка: порча не поймана — ${report.missed.join(', ')}.`);
      process.exit(1);
    }
    console.log(
      'Самопроверка: каждая порча канона цели поймана своей статьёй — проверка умеет краснеть.',
    );
  }

  if (failures.length > 0) {
    console.error('Круговой перенос: расхождения вне объявленных деградаций');
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }

  const written = [...rounds.values()].reduce(
    (total, round) =>
      total + round.plan.entries.filter((entry) => entry.outcome === 'written').length,
    0,
  );
  console.log(
    `Круговой перенос: ${rounds.size} CLI, временный дом, ${written} записей доехали и нашлись у цели; ` +
      `деградаций объявлено ${DECLARED.length}.`,
  );
}

await main();
