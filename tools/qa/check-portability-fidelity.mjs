/**
 * Матрица верности против опубликованной таблицы (П1.1).
 *
 * Матрица «слой × провайдер» в `TASKS-PORTABILITY.md` §3 — это ОБЕЩАНИЕ человеку.
 * Считает её код (`domains/portability/fidelity.ts`) по данным каталога. Эта
 * проверка сводит одно с другим: каждая клетка таблицы обязана совпасть с тем,
 * что модуль выдаёт для представителя этого слоя у этого провайдера. Разошлись —
 * красный: либо код посчитал не то, либо документ рассказывает о панели то, чего
 * в ней нет.
 *
 * Что ещё проверяется:
 *   1. у каждого «×» причина из ЗАКРЫТОГО словаря (критерий приёмки П1.1);
 *   2. условие и запасной уровень согласованы: есть условие — есть иной исход;
 *   3. перенос В Claude считается тоже (в таблице его столбца нет — он источник);
 *   4. выдуманный провайдер с пустым каталогом получает полный столбец, и ни
 *      один файл домена при этом не правится (§5.4).
 *
 * Запуск: `node tools/qa/check-portability-fidelity.mjs`
 * Самопроверка: `node tools/qa/check-portability-fidelity.mjs --selftest` —
 * подменяет клетку таблицы и возможность в каталоге и требует, чтобы проверка
 * покраснела ИМЕННО на них. Проверка, которая не может покраснеть, — украшение.
 */
import { readFileSync } from 'node:fs';

const selftest = process.argv.includes('--selftest');
const failures = [];

function check(name, condition, detail) {
  if (!condition) failures.push(detail ? `${name} — ${detail}` : name);
}

/** Буква матрицы по уровню верности. Словарь один на весь файл. */
const LETTER = {
  native: 'Н',
  emulated: 'Э',
  wired: 'П',
  text: 'Т',
  impossible: '×',
};

const src = {
  provider: 'claude',
  scope: 'global',
  origin: 'file',
  // Путь ВНУТРИ дома Claude: по нему видно, что цель читает тот же каталог.
  file: `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.claude/skills/doc-hygiene/SKILL.md`,
};

function item(over) {
  return {
    id: `${over.kind}:пример`,
    source: src,
    intent: 'представитель слоя',
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: { resolution: 'none', why: 'рантайм не нужен' },
    sideEffects: [],
    raw: '',
    ...over,
  };
}

/**
 * Представитель каждого слоя матрицы. Ключ — подпись строки таблицы так, как она
 * написана в плане; строка «Поведение CLI» каноном не едет вовсе и здесь её нет
 * намеренно (об этом сказано в самом плане).
 */
const LAYERS = [
  [
    'Инструкции и память',
    item({
      kind: 'instructions',
      fileName: 'CLAUDE.md',
      text: 'текст',
      includes: [],
      legacy: false,
      enabled: true,
    }),
  ],
  [
    'Скиллы',
    item({
      kind: 'skill',
      name: 'doc-hygiene',
      description: 'd',
      body: 'b',
      dir: `${src.file.replace('/SKILL.md', '')}`,
      enabled: true,
      trigger: { on: 'model' },
    }),
  ],
  [
    'Слэш-команды',
    item({
      kind: 'command',
      name: 'gate',
      namespace: null,
      description: 'd',
      prompt: 'p',
      trigger: { on: 'user' },
    }),
  ],
  [
    'Субагенты',
    item({
      kind: 'subagent',
      name: 'reviewer',
      description: 'd',
      tools: null,
      model: null,
      omitInstructions: false,
      trigger: { on: 'model' },
    }),
  ],
  [
    'Хуки: события сессии',
    item({
      kind: 'hook',
      command: 'node start.mjs',
      scriptPath: null,
      timeout: null,
      enabled: false,
      trigger: { on: 'session', event: 'session_start' },
      blocking: 'observes',
      needs: { resolution: 'facts', facts: ['session_id'], evidence: 'declared' },
    }),
  ],
  [
    'Хуки: события инструментов',
    item({
      kind: 'hook',
      command: 'node guard.mjs',
      scriptPath: null,
      timeout: null,
      enabled: false,
      trigger: { on: 'tool', event: 'pre_tool', match: null },
      blocking: 'blocks',
      needs: { resolution: 'facts', facts: ['tool_name', 'tool_input'], evidence: 'declared' },
    }),
  ],
  ['Права', item({ kind: 'permission', rule: 'Bash(rm -rf)', decision: 'deny', order: 0 })],
  [
    'MCP-серверы',
    item({
      kind: 'mcpServer',
      name: 'context7',
      transport: 'stdio',
      command: 'npx',
      args: [],
      url: null,
      envKeys: [],
    }),
  ],
  ['Переменные окружения', item({ kind: 'envVar', name: 'EDITOR', value: 'code' })],
  [
    'Секреты и ключи',
    item({ kind: 'secret', name: 'ANTHROPIC_API_KEY', mask: '…', holder: 'panel' }),
  ],
  [
    // Форма плагина названа: единицей плагин едет только в механизм СВОЕЙ формы
    // (П2.6). Строка таблицы говорит про плагин-модуль — файл, который цель
    // кладёт к себе; форма `installed` (магазин Claude, реестр kimi) единицей не
    // едет никуда, её содержимое едет обычными записями.
    'Плагины как единица',
    item({
      kind: 'plugin',
      name: 'pack',
      version: null,
      readOnly: false,
      provides: [],
      form: 'module',
    }),
  ],
  [
    'Группы и сценарии панели',
    item({ kind: 'panelGroup', name: 'гейт', description: 'd', members: [] }),
  ],
  [
    'Контекст разговоров',
    item({
      kind: 'conversation',
      title: 'разговор',
      turns: 4,
      lastActiveIso: '2026-09-19T00:00:00.000Z',
      workdir: null,
    }),
  ],
];

/** Клетка таблицы по приговору: уровень, а через косую — исход без условия. */
function cellOf(verdict) {
  const best = LETTER[verdict.level];
  // Запасной «невозможно» в таблицу не выносится: у уровня «эмуляция» отсутствие
  // панели и так означает, что запись не работает (это сказано в легенде).
  if (verdict.fallback === verdict.level || verdict.fallback === 'impossible') return best;
  return `${best}/${LETTER[verdict.fallback]}`;
}

/** Разобрать таблицу §3 плана: подпись строки → карта «провайдер → клетка». */
function parseMatrix(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| слой '));
  if (start < 0) throw new Error('в плане не найдена таблица §3 («| слой »)');
  const clean = (cell) =>
    cell
      .replaceAll('\\*', '')
      .replaceAll('*', '')
      .replace(/[†‡§¶⊘∅]/g, '')
      .trim();
  const columns = lines[start].split('|').slice(2, -1).map(clean);
  const rows = new Map();
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(clean);
    const [label, ...values] = cells;
    rows.set(label, new Map(columns.map((column, at) => [column, values[at]])));
  }
  return { columns, rows };
}

async function main() {
  const planPath = new URL('../../TASKS-PORTABILITY.md', import.meta.url);
  const { columns, rows } = parseMatrix(readFileSync(planPath, 'utf8'));

  const { level } = await import(
    new URL('../../apps/server/src/domains/portability/fidelity.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );
  const { fidelityReasons, fidelityConditions } = await import(
    new URL('../../packages/contracts/src/portable-fidelity.ts', import.meta.url).href
  );

  const byId = new Map(CATALOG_PROVIDERS.map((provider) => [provider.id, provider]));
  check('в таблице девять столбцов целевых CLI', columns.length === 9, `их ${columns.length}`);

  // --- 1. Клетка за клеткой: таблица против вычисления ------------------------
  for (const [label, canonItem] of LAYERS) {
    const published = rows.get(label);
    if (!published) {
      failures.push(`строки «${label}» нет в таблице §3 плана`);
      continue;
    }
    for (const column of columns) {
      const target = byId.get(column);
      if (!target) {
        failures.push(`столбец «${column}» не найден в каталоге провайдеров`);
        continue;
      }
      let verdict;
      try {
        verdict = level(canonItem, target);
      } catch (error) {
        failures.push(`${label} / ${column}: матрица бросила — ${error.message}`);
        continue;
      }
      const computed = cellOf(verdict);
      const expected =
        selftest && label === 'MCP-серверы' && column === 'codex' ? 'Т' : published.get(column);
      check(
        `${label} / ${column}`,
        computed === expected,
        `в плане «${expected}», вычислено «${computed}» (${verdict.reason})`,
      );
    }
  }

  // --- 2. Приговор всегда полон ----------------------------------------------
  for (const target of [claudeProvider, ...CATALOG_PROVIDERS]) {
    for (const [label, canonItem] of LAYERS) {
      const verdict = level(canonItem, target);
      check(
        `причина из словаря: ${label} / ${target.id}`,
        fidelityReasons.includes(verdict.reason),
        `причина «${verdict.reason}»`,
      );
      if (verdict.condition === null) {
        check(
          `без условия исход один: ${label} / ${target.id}`,
          verdict.fallback === verdict.level,
        );
      } else {
        check(
          `условие из словаря: ${label} / ${target.id}`,
          fidelityConditions.includes(verdict.condition),
          `условие «${verdict.condition}»`,
        );
        check(
          `условие называет иной исход: ${label} / ${target.id}`,
          verdict.fallback !== verdict.level,
        );
      }
    }
  }

  // --- 3. Одиннадцатый CLI: столбец считается без правки домена ---------------
  const invented = {
    id: 'одиннадцатый',
    name: 'Одиннадцатый CLI',
    status: 'experimental',
    paths: () => {
      throw new Error('не используется');
    },
    cli: { command: 'eleventh', windowsCommand: 'eleventh.cmd' },
    capabilities: {},
  };
  for (const [label, canonItem] of LAYERS) {
    let verdict;
    try {
      verdict = level(canonItem, invented);
    } catch (error) {
      failures.push(`выдуманный провайдер: ${label} бросил — ${error.message}`);
      continue;
    }
    check(
      `выдуманный провайдер: ${label} — «×» с причиной`,
      verdict.level === 'impossible' && fidelityReasons.includes(verdict.reason),
      `уровень «${verdict.level}», причина «${verdict.reason}»`,
    );
  }

  // --- 4. Подмена возможности обязана изменить матрицу -----------------------
  const gemini = byId.get('gemini');
  const commandItem = LAYERS.find(([label]) => label === 'Слэш-команды')[1];
  const withCommands = level(commandItem, gemini);
  const withoutCommands = level(commandItem, { ...gemini, commandsConfig: undefined });
  check(
    'подмена возможности меняет матрицу (каталог команд у gemini)',
    withCommands.level === 'native' && withoutCommands.level !== 'native',
    `с каталогом «${withCommands.level}», без каталога «${withoutCommands.level}»`,
  );

  // --- 5. Раздел «только для чтения» назван своей причиной -------------------
  //
  // Буква матрицы у такой клетки та же, что у «раздела нет вовсе» (`×`), и по
  // таблице эти два случая неразличимы. Разница вся в причине: у `kimi`
  // плагинами владеет его собственная команда `/plugins`, у `opencode` ключ
  // хуков исчез из схемы — панель их ПОКАЗЫВАЕТ, но не пишет, и человек обязан
  // прочитать именно это, а не «такого раздела у цели нет».
  const readOnlyCases = [
    ['Плагины как единица', (provider) => provider.pluginsConfig?.format === 'kimi-plugins'],
    ['Хуки: события сессии', (provider) => Boolean(provider.hooksConfig?.writeDisabledReason)],
  ];
  for (const [label, isReadOnly] of readOnlyCases) {
    const canonItem = LAYERS.find(([name]) => name === label)[1];
    const targets = CATALOG_PROVIDERS.filter(isReadOnly);
    check(`раздел только для чтения: «${label}» есть хоть у одной цели`, targets.length > 0);
    for (const target of targets) {
      const verdict = level(canonItem, target);
      check(
        `раздел только для чтения: ${label} / ${target.id}`,
        verdict.reason === 'mechanism_read_only',
        `причина «${verdict.reason}», а раздел в каталоге помечен нечитаемым для записи`,
      );
    }
  }

  // --- 6. Провод не обещает того, чего не видит ------------------------------
  //
  // Контур сидит в ПУТИ ЗАПРОСА: вызовы инструментов и текст запроса он видит, а
  // старт сессии, её конец и сжатие контекста — нет. Запись, требования которой
  // вывести не удалось («нужно всё сразу»), получала `П` у любой цели с
  // адресом — обещание контура там, где он бессилен.
  const sessionItem = LAYERS.find(([label]) => label === 'Хуки: события сессии')[1];
  const undeterminedHook = {
    ...sessionItem,
    needs: { resolution: 'undetermined', why: 'скрипт не разобран' },
  };
  for (const target of [claudeProvider, ...CATALOG_PROVIDERS]) {
    const verdict = level(undeterminedHook, target);
    check(
      `провод вне пути запроса: хук сессии / ${target.id}`,
      verdict.level !== 'wired' && verdict.fallback !== 'wired',
      `уровень «${verdict.level}», без условия «${verdict.fallback}» (${verdict.reason})`,
    );
  }

  // --- 7. Перенос В Claude считается, хотя столбца в таблице нет --------------
  for (const [label, canonItem] of LAYERS) {
    const verdict = level(canonItem, claudeProvider);
    if (label === 'Плагины как единица') {
      // Единственный слой, который в Claude единицей не едет: его плагины
      // ставятся из магазина, а установка плагинов у цели вне объёма (П2.6).
      // Требовать тут уровень значило бы пообещать установку, которой нет.
      // Зато причина обязана называть ИМЕННО это, а не «механизма нет»: иначе
      // человек прочтёт отказ как отсутствие раздела у цели.
      check(
        `перенос в claude: ${label} — назван непереносимой единицей`,
        verdict.reason === 'unit_not_installable',
        `уровень «${verdict.level}» (${verdict.reason})`,
      );
      continue;
    }
    check(
      `перенос в claude: ${label}`,
      verdict.level !== 'impossible',
      `уровень «${verdict.level}» (${verdict.reason})`,
    );
  }
}

await main();

if (selftest) {
  const poisoned = failures.filter((line) => line.startsWith('MCP-серверы / codex'));
  if (poisoned.length !== 1) {
    console.error(
      `САМОПРОВЕРКА ПРОВАЛЕНА: подменённая клетка «MCP-серверы / codex» не поймана (поймано ${poisoned.length})`,
    );
    process.exit(1);
  }
  if (failures.length !== 1) {
    console.error('САМОПРОВЕРКА ПРОВАЛЕНА: кроме подменённой клетки покраснело что-то ещё:');
    for (const line of failures.filter((entry) => !entry.startsWith('MCP-серверы / codex'))) {
      console.error(`  - ${line}`);
    }
    process.exit(1);
  }
  console.log('Самопроверка: подменённая клетка поймана по имени, остальное зелено.');
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`Матрица верности разошлась с планом (${failures.length}):`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`Матрица верности: ${LAYERS.length} слоёв × 9 CLI сошлись с §3 плана.`);
