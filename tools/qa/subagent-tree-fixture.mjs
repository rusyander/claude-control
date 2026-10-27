/**
 * Синтетический разговор с деревом субагентов — для проверки дерева агентов
 * (`check-subagent-tree.mjs`). Всё придумано: репозиторий публичный, настоящие
 * транскрипты в него не попадают.
 *
 * Раскладка — как у CLI (claude 2.1.3xx): главный транскрипт
 * `projects/<папка>/<сессия>.jsonl`, рядом `<сессия>/subagents/agent-<id>.jsonl`
 * и `agent-<id>.meta.json` с `toolUseId` вызова, которым агент запущен.
 *
 * Что в дереве:
 * - «Разведка» (Explore) — закончил, три вызова, свой результат;
 * - «Ревью» (general-purpose) — в фоне, ещё идёт, а внутри запустил своего
 *   субагента «Проверка тестов» (вложенный, второй уровень);
 * - «Сборка» — упал (результат вызова с ошибкой);
 * - «Потерянный в середине» — его вызова в прочитанной части главного
 *   транскрипта нет, есть только файлы субагента (так теряется середина файла
 *   больше 4 МБ) — узел строится по meta.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TREE_SESSION = '7e3c1a52-0d4b-4a8e-9b1f-5c2d7a6e9f01';
export const AGENT_IDS = {
  explore: 'a1e0c0ffee0000001',
  review: 'a2e0c0ffee0000002',
  nested: 'a3e0c0ffee0000003',
  build: 'a4e0c0ffee0000004',
  orphan: 'a5e0c0ffee0000005',
};

const line = (record) => JSON.stringify(record);
const usage = (input, output) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: input * 4,
  cache_creation_input_tokens: 0,
});

/**
 * Вставки хуков, как их пишет CLI: `hook_success` (команда, замер, код выхода)
 * и `hook_additional_context` (текст, дописанный в контекст модели). `minutes`
 * — от начала транскрипта.
 */
function hookRecords(base, at, hooks = []) {
  return hooks.map(({ minutes, ...attachment }) => ({
    ...base,
    type: 'attachment',
    timestamp: at(minutes),
    attachment,
  }));
}

/** Записи по времени: вставки хуков встают между шагами, а не в конец. */
const byTime = (records) =>
  records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => a.record.timestamp.localeCompare(b.record.timestamp) || a.index - b.index)
    .map(({ record }) => record);

/**
 * Записи одного субагента: задание, шаги с вызовами и (если закончил) итог.
 * `open` — последний вызов без результата: агент занят им прямо сейчас;
 * `hooks` — вставки хуков между шагами; `step.isError` — вызов кончился ошибкой
 * (так CLI пишет и отказ хука перед вызовом).
 */
function agentLog({ agentId, sessionId, cwd, model, prompt, steps, final, start, open, hooks }) {
  const at = (minutes) => new Date(start + minutes * 60_000).toISOString();
  const base = { isSidechain: true, agentId, sessionId, cwd };
  const records = [
    { ...base, type: 'user', timestamp: at(0), message: { role: 'user', content: prompt } },
  ];
  steps.forEach((step, index) => {
    const id = `toolu_${agentId}_${index}`;
    records.push({
      ...base,
      type: 'assistant',
      timestamp: at(index + 0.5),
      message: {
        id: `msg_${agentId}_${index}`,
        role: 'assistant',
        model,
        content: [
          ...(step.say ? [{ type: 'text', text: step.say }] : []),
          { type: 'tool_use', id, name: step.tool, input: step.input },
        ],
        usage: usage(1200 + index * 300, 180 + index * 20),
      },
    });
    const isLast = index === steps.length - 1;
    if (open && isLast) return;
    records.push({
      ...base,
      type: 'user',
      timestamp: at(index + 1),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            ...(step.isError ? { is_error: true } : {}),
            content: [{ type: 'text', text: step.result ?? 'ok' }],
          },
        ],
      },
    });
  });
  records.push(...hookRecords(base, at, hooks));
  if (final) {
    records.push({
      ...base,
      type: 'assistant',
      timestamp: at(steps.length + 0.5),
      message: {
        id: `msg_${agentId}_final`,
        role: 'assistant',
        model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: final }],
        usage: usage(2000, 400),
      },
    });
  }
  return `${byTime(records).map(line).join('\n')}\n`;
}

function writeAgent(dir, agentId, meta, log) {
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), log, 'utf8');
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8');
}

/** Главный транскрипт: человек просит, агент раздаёт работу трём субагентам. */
function mainLog({ sessionId, cwd, start }) {
  const at = (minutes) => new Date(start + minutes * 60_000).toISOString();
  const base = { sessionId, cwd, isSidechain: false };
  const call = (minutes, id, kind, description, prompt) => ({
    ...base,
    type: 'assistant',
    timestamp: at(minutes),
    message: {
      id: `msg_main_${id}`,
      role: 'assistant',
      model: 'claude-opus-4-1',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { subagent_type: kind, description, prompt },
        },
      ],
      usage: usage(3000, 200),
    },
  });
  const result = (minutes, id, text, isError = false) => ({
    ...base,
    type: 'user',
    timestamp: at(minutes),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          ...(isError ? { is_error: true } : {}),
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
  const records = [
    {
      ...base,
      type: 'user',
      timestamp: at(0),
      message: { role: 'user', content: 'Разбери модуль отчётов и проверь сборку' },
    },
    // Главный агент сам: хук старта сессии и скилл перед раздачей работы.
    ...hookRecords(base, at, [
      {
        minutes: 0.05,
        type: 'hook_success',
        hookName: 'SessionStart:startup',
        hookEvent: 'SessionStart',
        command: 'node "/home/qa/.claude/hooks/session-brief.mjs"',
        exitCode: 0,
        durationMs: 240,
      },
    ]),
    {
      ...base,
      type: 'assistant',
      timestamp: at(0.2),
      message: {
        id: 'msg_main_skill',
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [
          { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'reports-plan' } },
        ],
        usage: usage(2800, 60),
      },
    },
    result(0.3, 'toolu_skill', 'Скилл загружен'),
    call(0.5, 'toolu_explore', 'Explore', 'Разведка модуля отчётов', 'Найди, где строятся отчёты'),
    result(
      4,
      'toolu_explore',
      'Отчёты строятся в src/reports/build.ts, точка входа — renderReport.\nagentId: a1e0c0ffee0000001',
    ),
    call(4.5, 'toolu_review', 'general-purpose', 'Ревью правок отчётов', 'Проверь правки отчётов'),
    result(
      4.6,
      'toolu_review',
      'Async agent launched successfully.\nagentId: a2e0c0ffee0000002 (internal ID)',
    ),
    call(5, 'toolu_build', 'general-purpose', 'Сборка отчётов', 'Собери пакет отчётов'),
    result(7, 'toolu_build', 'Сборка упала: модуль chart не найден', true),
    {
      ...base,
      type: 'assistant',
      timestamp: at(7.5),
      message: {
        id: 'msg_main_say',
        role: 'assistant',
        model: 'claude-opus-4-1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Разведка готова, ревью идёт в фоне, сборка упала.' }],
        usage: usage(3500, 300),
      },
    },
  ];
  return `${records.map(line).join('\n')}\n`;
}

/**
 * Засеять разговор в каталог конфигурации стенда. `start` — когда разговор
 * начался: от него считаются «идёт N мин» и «писал N назад».
 */
export function seedSubagentTree({ cfg, cwd, sessionId = TREE_SESSION, start }) {
  const dir = join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const agents = join(dir, sessionId, 'subagents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), mainLog({ sessionId, cwd, start }), 'utf8');
  const minute = 60_000;
  writeAgent(
    agents,
    AGENT_IDS.explore,
    { agentType: 'Explore', description: 'Разведка модуля отчётов', toolUseId: 'toolu_explore' },
    agentLog({
      agentId: AGENT_IDS.explore,
      sessionId,
      cwd,
      model: 'claude-haiku-4-5',
      prompt: 'Найди, где строятся отчёты',
      start: start + 0.5 * minute,
      steps: [
        { tool: 'Grep', input: { pattern: 'renderReport' }, result: 'src/reports/build.ts:12' },
        { tool: 'Read', input: { file_path: 'src/reports/build.ts' }, result: 'export function…' },
        { tool: 'Glob', input: { pattern: 'src/reports/**/*.ts' }, result: '4 files' },
      ],
      final: 'Отчёты строятся в src/reports/build.ts, точка входа — renderReport.',
    }),
  );
  writeAgent(
    agents,
    AGENT_IDS.review,
    {
      agentType: 'general-purpose',
      description: 'Ревью правок отчётов',
      toolUseId: 'toolu_review',
      model: 'claude-sonnet-4-5',
    },
    agentLog({
      agentId: AGENT_IDS.review,
      sessionId,
      cwd,
      model: 'claude-sonnet-4-5',
      prompt: 'Проверь правки отчётов',
      start: start + 4.5 * minute,
      open: true,
      steps: [
        { tool: 'Read', input: { file_path: 'src/reports/table.ts' }, result: '…' },
        {
          tool: 'Agent',
          say: 'Тесты проверит отдельный агент.',
          input: {
            subagent_type: 'Explore',
            description: 'Проверка тестов отчётов',
            prompt: 'Найди тесты отчётов и скажи, что они покрывают',
          },
          result: 'Тесты покрывают таблицу и итоги.',
        },
        { tool: 'Bash', input: { command: 'pnpm vitest run src/reports' } },
      ],
    }),
  );
  // Вложенный: его вызов лежит в транскрипте «Ревью», не в главном.
  writeAgent(
    agents,
    AGENT_IDS.nested,
    {
      agentType: 'Explore',
      description: 'Проверка тестов отчётов',
      toolUseId: `toolu_${AGENT_IDS.review}_1`,
      spawnDepth: 2,
    },
    agentLog({
      agentId: AGENT_IDS.nested,
      sessionId,
      cwd,
      model: 'claude-haiku-4-5',
      prompt: 'Найди тесты отчётов и скажи, что они покрывают',
      start: start + 5.5 * minute,
      steps: [{ tool: 'Glob', input: { pattern: '**/*.test.ts' }, result: '2 files' }],
      final: 'Тесты покрывают таблицу и итоги.',
    }),
  );
  writeAgent(
    agents,
    AGENT_IDS.build,
    { agentType: 'general-purpose', description: 'Сборка отчётов', toolUseId: 'toolu_build' },
    agentLog({
      agentId: AGENT_IDS.build,
      sessionId,
      cwd,
      model: 'claude-sonnet-4-5',
      prompt: 'Собери пакет отчётов',
      start: start + 5 * minute,
      // Скилл, MCP, отказ хука перед вызовом и два хука — окно «Скиллы, хуки и MCP».
      steps: [
        { tool: 'Skill', input: { skill: 'reports-build' }, result: 'Скилл загружен' },
        {
          tool: 'mcp__tracker__get_issue',
          input: { key: 'PROJ-12' },
          result: 'PROJ-12: отчёты падают на графиках',
        },
        {
          tool: 'Bash',
          input: { command: 'git push origin reports' },
          isError: true,
          result: 'PreToolUse:Bash hook error: [git-guard] push needs the owner’s yes',
        },
        {
          tool: 'Bash',
          input: { command: 'pnpm --filter reports build' },
          result: 'Error: Cannot find module chart',
        },
      ],
      hooks: [
        {
          minutes: 3.2,
          type: 'hook_success',
          hookName: 'PreToolUse:Bash',
          hookEvent: 'PreToolUse',
          command: 'node "/home/qa/.claude/hooks/gate-at-end.mjs"',
          exitCode: 0,
          durationMs: 85,
        },
        {
          minutes: 3.3,
          type: 'hook_additional_context',
          hookName: 'PostToolUse:Bash',
          content: ['[context-watch] контекст 62% — пора /clear'],
        },
      ],
      final: 'Сборка упала: модуль chart не найден',
    }),
  );
  writeAgent(
    agents,
    AGENT_IDS.orphan,
    {
      agentType: 'Plan',
      description: 'Потерянный в середине',
      toolUseId: 'toolu_orphan',
      finished: true,
    },
    agentLog({
      agentId: AGENT_IDS.orphan,
      sessionId,
      cwd,
      model: 'claude-sonnet-4-5',
      prompt: 'Составь план миграции отчётов',
      start: start + 1 * minute,
      steps: [{ tool: 'Read', input: { file_path: 'docs/reports.md' }, result: '…' }],
      final: 'План из трёх шагов.',
    }),
  );
  return { dir, sessionId };
}
