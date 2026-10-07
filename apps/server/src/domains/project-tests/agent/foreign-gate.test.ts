import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { runScope, startPermissionGate, type RunPermissionGate } from '../run-permissions.ts';
import {
  QWEN_TESTS_EXCLUDED_TOOLS,
  QWEN_TOOL_NAMES,
  codexChangesOf,
  codexLegacyChangesOf,
  codexVerdict,
  composeQwenGateSettings,
  decideCodexChanges,
  decideCodexCommand,
  decideQwenCall,
  normalizeQwenCall,
  unexpectedQwenTools,
} from './foreign-gate.ts';

/**
 * Проверка прав прогона у чужого CLI. Главное отличие от Claude держится здесь:
 * незнакомый инструмент — отказ, пишущий вызов без пути — отказ, и ответ Codex
 * никогда не бывает «разрешить до конца сессии».
 */
const ROOT = resolve(tmpdir(), 'cc-foreign-gate-root');
const at = (...parts: string[]): string => join(ROOT, ...parts);
const KIT_PATHS = fileURLToPath(
  new URL('../../../../assets/kit/agentdeck-kit/hooks/lib/kit-paths.mjs', import.meta.url),
);

/** Инструменты кадра `init` Qwen Code 0.25 — снято живой пробой P1. */
const QWEN_025_INIT = [
  'read_mcp_resource',
  'read_file',
  'zoom_image',
  'grep_search',
  'cron_create',
  'cron_list',
  'cron_delete',
  'list_agents',
  'task_stop',
  'send_message',
  'skill',
  'search_memory',
  'glob',
  'record_artifact',
  'loop_wakeup',
  'get_goal',
  'update_goal',
  'tool_call',
  'agent',
  'notebook_edit',
  'run_shell_command',
  'report_findings',
  'enter_worktree',
  'exit_worktree',
  'monitor',
  'web_fetch',
  'tool_search',
  'manage_memory',
  'write_file',
  'edit',
];

describe('project-tests/agent/foreign-gate: Qwen Code', () => {
  const scope = runScope(ROOT, 'run');

  it('карта имён совпадает с картой набора панели (kit-paths.mjs QWEN_TOOLS)', () => {
    const source = readFileSync(KIT_PATHS, 'utf8');
    const block = /const QWEN_TOOLS = \{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
    const kit = Object.fromEntries(
      [...block.matchAll(/(\w+):\s*'(\w+)'/g)].map((match) => [match[1], match[2]]),
    );
    expect(Object.keys(kit).length).toBeGreaterThan(5);
    for (const [qwen, claude] of Object.entries(kit)) {
      // Субагент снят с запуска — его имени в карте прогона нет нарочно.
      if (claude === 'Agent') expect(QWEN_TOOL_NAMES[qwen]).toBeUndefined();
      else expect(QWEN_TOOL_NAMES[qwen], qwen).toBe(claude);
    }
  });

  it('набор живой 0.25 = карта + снятые: сверка init молчит, новый инструмент виден', () => {
    const left = QWEN_025_INIT.filter((name) => !QWEN_TESTS_EXCLUDED_TOOLS.includes(name));
    expect(unexpectedQwenTools(left)).toEqual([]);
    expect(unexpectedQwenTools([...left, 'brand_new_writer'])).toEqual(['brand_new_writer']);
    expect(unexpectedQwenTools('garbage')).toEqual([]);
  });

  it('инструменты MCP канарейку init не обрывают — их вызовы отклоняет хук', () => {
    expect(unexpectedQwenTools(['read_file', 'mcp__playwright__browser_click'])).toEqual([]);
    expect(decideQwenCall(scope, 'mcp__playwright__browser_click', {}).behavior).toBe('deny');
  });

  it.each(['notebook_edit', 'tool_call', 'agent', 'save_memory', 'mcp__x__y', ''])(
    'незнакомый инструмент «%s» — отказ (у Claude был бы пропуск)',
    (name) => {
      const decision = decideQwenCall(scope, name, { file_path: at('.agent', 'tests', 'a.json') });
      expect(decision.behavior).toBe('deny');
      expect(decision.message).toMatch(/not available in this test run/);
    },
  );

  it.each([
    ['write_file', { file_path: at('.agent', 'tests', 'g.tests.json'), content: '{}' }],
    [
      'edit',
      { file_path: at('.agent', 'tests', 'g.tests.json'), old_string: 'a', new_string: 'b' },
    ],
    ['replace', { file_path: at('.agent', 'tests', 'g.tests.json') }],
    ['write_file', { absolute_path: at('.agent', 'tests', 'x.json') }],
  ])('%s внутри .agent/tests — разрешено', (name, input) => {
    expect(decideQwenCall(scope, name, input).behavior).toBe('allow');
  });

  it.each([
    ['write_file', { file_path: at('src', 'evil.ts'), content: 'x' }],
    ['edit', { file_path: at('src', 'app.ts'), old_string: 'a', new_string: 'b' }],
    ['replace', { file_path: at('..', 'outside.txt') }],
  ])('%s вне границ — отказ с границами словами', (name, input) => {
    const decision = decideQwenCall(scope, name, input);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/writing is allowed only inside \.agent\/tests\//);
  });

  it('пишущий вызов без пути — отказ (у Claude прошёл бы)', () => {
    expect(decideQwenCall(scope, 'write_file', { content: 'x' }).behavior).toBe('deny');
    expect(decideQwenCall(scope, 'edit', {}).behavior).toBe('deny');
    expect(decideQwenCall(scope, 'write_file', 'not-an-object').behavior).toBe('deny');
  });

  it('оболочка: правка истории — отказ, прочее — можно, пустая команда — отказ', () => {
    expect(
      decideQwenCall(scope, 'run_shell_command', { command: 'git commit -am x' }).behavior,
    ).toBe('deny');
    expect(decideQwenCall(scope, 'run_shell_command', { command: 'npm test' }).behavior).toBe(
      'allow',
    );
    expect(decideQwenCall(scope, 'run_shell_command', {}).behavior).toBe('deny');
  });

  it('чтение и поиск — без вопросов', () => {
    for (const name of ['read_file', 'read_many_files', 'glob', 'grep_search', 'web_fetch']) {
      expect(decideQwenCall(scope, name, { file_path: at('src', 'app.ts') }).behavior, name).toBe(
        'allow',
      );
    }
  });

  it('генерация пишет только черновики', () => {
    const generate = runScope(ROOT, 'generate');
    const draft = at('.agent', 'tests', 'drafts', 'r1.draft.json');
    expect(decideQwenCall(generate, 'write_file', { file_path: draft }).behavior).toBe('allow');
    expect(
      decideQwenCall(generate, 'write_file', { file_path: at('.agent', 'tests', 'g.tests.json') })
        .behavior,
    ).toBe('deny');
  });

  it('automate: названный кейсом файл автотеста — можно', () => {
    const cases = [{ automation: { status: 'automated', file: 'e2e/login.spec.ts' } }];
    const automate = runScope(ROOT, 'automate', cases as unknown as ProjectTestCase[]);
    expect(
      decideQwenCall(automate, 'edit', { file_path: at('e2e', 'login.spec.ts') }).behavior,
    ).toBe('allow');
  });

  it('нормализация отдаёт форму Claude', () => {
    expect(normalizeQwenCall('run_shell_command', { command: 'ls' })).toEqual({
      tool: 'Bash',
      input: { command: 'ls' },
    });
    expect(normalizeQwenCall('read_file', { absolute_path: '/a' })?.input.file_path).toBe('/a');
    expect(normalizeQwenCall('nope', {})).toBeUndefined();
  });
});

describe('project-tests/agent/foreign-gate: Codex', () => {
  const scope = runScope(ROOT, 'run');
  const change = (path: string, type: string, move_path?: string) => ({
    path,
    kind: { type, ...(move_path ? { move_path } : {}) },
    diff: '',
  });

  it('новый файл в .agent/tests — accept', () => {
    const decision = decideCodexChanges(
      scope,
      codexChangesOf([change(at('.agent', 'tests', 'g.tests.json'), 'add')]),
    );
    expect(codexVerdict(decision)).toBe('accept');
  });

  it.each([
    ['add вне границ', [change(at('src', 'evil.ts'), 'add')]],
    ['update вне границ', [change(at('src', 'app.ts'), 'update')]],
    ['delete вне границ', [change(at('src', 'app.ts'), 'delete')]],
    ['перенос наружу', [change(at('.agent', 'tests', 'a.json'), 'update', at('src', 'a.json'))]],
    [
      'перенос внутрь из кода',
      [change(at('src', 'a.json'), 'update', at('.agent', 'tests', 'a.json'))],
    ],
    [
      'пачка с одной правкой наружу',
      [change(at('.agent', 'tests', 'ok.json'), 'add'), change(at('src', 'evil.ts'), 'add')],
    ],
  ])('%s — decline', (_label, changes) => {
    const decision = decideCodexChanges(scope, codexChangesOf(changes));
    expect(codexVerdict(decision)).toBe('decline');
    expect(decision.message).toMatch(/forbidden for this run/);
  });

  it('неизвестный элемент или кривая форма — decline', () => {
    expect(codexVerdict(decideCodexChanges(scope, undefined))).toBe('decline');
    expect(codexChangesOf([])).toBeUndefined();
    expect(codexChangesOf([{ path: 'a', kind: { type: 'rename' } }])).toBeUndefined();
    expect(codexChangesOf([{ kind: { type: 'add' } }])).toBeUndefined();
    expect(codexChangesOf('x')).toBeUndefined();
  });

  it('устаревший applyPatchApproval: относительный путь от корня проекта', () => {
    const inside = codexLegacyChangesOf({
      '.agent/tests/g.tests.json': { type: 'add', content: '' },
    });
    expect(codexVerdict(decideCodexChanges(scope, inside))).toBe('accept');
    const outside = codexLegacyChangesOf({
      '.agent/tests/a.json': { type: 'update', unified_diff: '', move_path: 'src/a.json' },
    });
    expect(codexVerdict(decideCodexChanges(scope, outside))).toBe('decline');
    expect(codexLegacyChangesOf({})).toBeUndefined();
  });

  it('команда: git commit в обёртке или в commandActions — decline', () => {
    const wrapped = {
      command: `"C:\\pwsh.exe" -Command 'git commit -am x'`,
      commandActions: [{ type: 'unknown', command: 'git commit -am x' }],
    };
    expect(codexVerdict(decideCodexCommand(scope, wrapped))).toBe('decline');
    expect(
      codexVerdict(
        decideCodexCommand(scope, {
          command: 'pwsh -Command run',
          commandActions: [{ command: 'git push' }],
        }),
      ),
    ).toBe('decline');
    // Устаревший execCommandApproval: команда — массивом.
    expect(codexVerdict(decideCodexCommand(scope, { command: ['git', 'reset', '--hard'] }))).toBe(
      'decline',
    );
  });

  it('обычная команда — accept; без команды — decline', () => {
    expect(
      codexVerdict(
        decideCodexCommand(scope, { command: 'pwsh -Command npm test', commandActions: [] }),
      ),
    ).toBe('accept');
    expect(codexVerdict(decideCodexCommand(scope, {}))).toBe('decline');
  });

  it('acceptForSession не бывает никогда', () => {
    const verdicts = new Set([
      codexVerdict({ behavior: 'allow' }),
      codexVerdict({ behavior: 'deny', message: 'x' }),
    ]);
    expect([...verdicts].sort()).toEqual(['accept', 'decline']);
  });
});

describe('project-tests/agent/foreign-gate: системные настройки Qwen', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-qwen-gate-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('хук первым, чужой системный слой сохранён, disableAllHooks снят', () => {
    const base = join(dir, 'base.json');
    writeFileSync(
      base,
      JSON.stringify({
        disableAllHooks: true,
        mcpServers: { grp: { command: 'node' } },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'start' }] }],
        },
      }),
    );
    const settings = composeQwenGateSettings(
      { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
      '"node" "gate.mjs"',
    );
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.mcpServers).toEqual({ grp: { command: 'node' } });
    const hooks = settings.hooks as Record<string, { matcher?: string; hooks: unknown[] }[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse![0]).toEqual({
      hooks: [{ type: 'command', command: '"node" "gate.mjs"', timeout: 15_000 }],
    });
    expect(hooks.PreToolUse![0]!.matcher).toBeUndefined();
    expect(hooks.PreToolUse![1]!.matcher).toBe('Bash');
    expect(hooks.SessionStart).toHaveLength(1);
  });

  it('без системного слоя — только хук', () => {
    const settings = composeQwenGateSettings(
      { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(dir, 'missing.json') },
      'gate',
    );
    expect(settings).toEqual({
      disableAllHooks: false,
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'gate', timeout: 15_000 }] }] },
    });
  });
});

describe('project-tests/agent/foreign-gate: приёмник с правилами Qwen', () => {
  let gate: RunPermissionGate | undefined;
  afterEach(() => gate?.close());

  const post = async (target: RunPermissionGate, body: unknown) => {
    const response = await fetch(target.baseUrl, { method: 'POST', body: JSON.stringify(body) });
    return (await response.json()) as { behavior: string; message?: string };
  };

  it('решает по-Qwen и помнит, что ответил по id вызова', async () => {
    const denies: string[] = [];
    gate = await startPermissionGate(
      runScope(ROOT, 'run'),
      (tool) => denies.push(tool),
      decideQwenCall,
    );
    const ok = await post(gate, {
      runId: gate.runId,
      toolName: 'write_file',
      input: { file_path: at('.agent', 'tests', 'g.json') },
      toolCallId: 'call_1',
    });
    const bad = await post(gate, {
      runId: gate.runId,
      toolName: 'write_file',
      input: { file_path: at('src', 'evil.ts') },
      toolCallId: 'call_2',
    });
    const odd = await post(gate, {
      runId: gate.runId,
      toolName: 'notebook_edit',
      toolCallId: 'c3',
    });
    const alien = await post(gate, { runId: 'other', toolName: 'read_file', toolCallId: 'c4' });
    expect([ok.behavior, bad.behavior, odd.behavior, alien.behavior]).toEqual([
      'allow',
      'deny',
      'deny',
      'deny',
    ]);
    expect(gate.decided('call_1')).toBe('allow');
    expect(gate.decided('call_2')).toBe('deny');
    expect(gate.decided('c3')).toBe('deny');
    // Чужой ключ в учёт не попадает: подделать «разрешено» снаружи нельзя.
    expect(gate.decided('c4')).toBeUndefined();
    expect(gate.decided('never')).toBeUndefined();
    expect(denies).toEqual(['write_file', 'notebook_edit', 'read_file']);
  });
});
