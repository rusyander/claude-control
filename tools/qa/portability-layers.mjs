/**
 * Представители слоёв матрицы «слой × провайдер» — одна запись канона на строку
 * таблицы §3 плана.
 *
 * Зачем отдельный файл. Матрицу сводят с планом две проверки:
 * `check-portability-fidelity.mjs` (клетка за клеткой) и
 * `check-portability-eleventh.mjs` (столбец выдуманного CLI и роспись живой
 * приёмки). Вторая копия представителей означала бы, что они разъедутся, и тогда
 * зелёная проверка доказывала бы уже не одно и то же: «скилл» у одной был бы с
 * телом, у другой без. Поэтому представители живут тут, а проверки их читают.
 */

/** Буква матрицы по уровню верности. Словарь один на обе проверки. */
export const LETTER = {
  native: 'Н',
  emulated: 'Э',
  wired: 'П',
  text: 'Т',
  impossible: '×',
};

export const src = {
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
export const LAYERS = [
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

/** Запись слоя по подписи строки таблицы. Нет такой строки — это ошибка вызова. */
export function layerItem(label) {
  const found = LAYERS.find(([name]) => name === label);
  if (!found) throw new Error(`слоя «${label}» нет среди представителей`);
  return found[1];
}

/** Клетка таблицы по приговору: уровень, а через косую — исход без условия. */
export function cellOf(verdict) {
  const best = LETTER[verdict.level];
  // Запасной «невозможно» в таблицу не выносится: у уровня «эмуляция» отсутствие
  // панели и так означает, что запись не работает (это сказано в легенде).
  if (verdict.fallback === verdict.level || verdict.fallback === 'impossible') return best;
  return `${best}/${LETTER[verdict.fallback]}`;
}
