import { describe, expect, it } from 'vitest';
import type { ChatMessage, HookTrace } from '@agentdeck/contracts';
import { scriptCommands } from './scriptCommands';
import { buildTurnTrail, turnTrails } from './turnTrail';

const bash = (command: string, description?: string) => ({
  name: 'Bash',
  input: JSON.stringify({ command, ...(description ? { description } : {}) }),
});

describe('scriptCommands — что считается скриптом', () => {
  it.each([
    [
      'node scripts/check_docs_gate.mjs --base origin/main',
      ['node scripts/check_docs_gate.mjs --base origin/main'],
    ],
    ['node --experimental-strip-types tools/a.ts', ['node --experimental-strip-types tools/a.ts']],
    ['python3 manage.py migrate', ['python3 manage.py migrate']],
    ['bash ./deploy.sh', ['bash ./deploy.sh']],
    ['deno run -A x.ts', ['deno run -A x.ts']],
    ['bun run dev', ['bun run dev']],
    ['./x.sh', ['./x.sh']],
    ['../tools/run', ['../tools/run']],
    ['~/bin/sync.sh', ['~/bin/sync.sh']],
    ['pnpm test', ['pnpm test']],
    ['npm run build', ['npm run build']],
    ['yarn lint', ['yarn lint']],
    ['pnpm --filter web dev -- --port 5191', ['pnpm --filter web dev -- --port 5191']],
    ['make build', ['make build']],
    ['CI=1 pnpm test', ['pnpm test']],
    ['cd apps/web && pnpm type-check && pnpm lint', ['pnpm type-check', 'pnpm lint']],
    ['node scripts/a.mjs | tail -5', ['node scripts/a.mjs']],
  ])('%s → скрипт', (command, expected) => {
    expect(scriptCommands(command)).toEqual(expected);
  });

  it.each([
    'git status',
    'grep -rn foo src',
    'ls -la',
    'cat package.json',
    "sed -n '1,20p' a.ts",
    'curl -s http://127.0.0.1:5178/api/system',
    'node -e "console.log(1)"',
    'python3 -c "print(1)"',
    'python3 -m pytest',
    'python3 -m json.tool data.json',
    'node --version',
    'pnpm install',
    'npm i lodash',
    'pnpm exec vitest run',
    'yarn add react',
    '/bin/ls',
    '',
  ])('%s → не скрипт', (command) => {
    expect(scriptCommands(command)).toEqual([]);
  });
});

const hook = (fields: Partial<HookTrace> & Pick<HookTrace, 'hookName'>): HookTrace => ({
  event: fields.hookName.split(':')[0] ?? fields.hookName,
  ...fields,
});

describe('buildTurnTrail — сборка следа', () => {
  it('скиллы, агенты и скрипты из вызовов; MCP и простые команды мимо', () => {
    const trail = buildTurnTrail([
      { name: 'Skill', input: JSON.stringify({ skill: 'deep-review' }) },
      { name: 'Skill', input: JSON.stringify({ skill: 'deep-review' }) },
      {
        name: 'Agent',
        input: JSON.stringify({
          subagent_type: 'Explore',
          description: 'Telegram code map',
          model: 'sonnet',
          prompt: 'длинное задание',
        }),
      },
      { name: 'Task', input: JSON.stringify({ description: 'старое имя инструмента' }) },
      bash('node scripts/check_docs_gate.mjs', 'Гейт документации'),
      bash('pnpm test'),
      bash('pnpm test', 'второй раз'),
      bash('git status'),
      { name: 'mcp__playwright__browser_click', input: '{}' },
      { name: 'Read', input: JSON.stringify({ file_path: 'a.ts' }) },
      { name: 'Bash', input: 'не JSON' },
    ]);
    expect(trail).toEqual({
      skills: ['deep-review'],
      agents: [
        { type: 'Explore', description: 'Telegram code map', model: 'sonnet' },
        { description: 'старое имя инструмента' },
      ],
      scripts: [
        { command: 'node scripts/check_docs_gate.mjs', description: 'Гейт документации', count: 1 },
        { command: 'pnpm test', count: 2 },
      ],
      hooks: [],
      hookCount: 0,
      contextCount: 0,
      hookMs: 0,
    });
  });

  it('хуки по имени CLI и команде: счёт ×N, сумма времени, контекст, сбой', () => {
    const trail = buildTurnTrail(
      [],
      [
        hook({ hookName: 'UserPromptSubmit', context: 'самопроверка' }),
        hook({ hookName: 'UserPromptSubmit', name: 'review-trigger', context: 'ревью' }),
        ...Array.from({ length: 24 }, () =>
          hook({ hookName: 'PostToolUse:Bash', name: 'inject-project-rules', durationMs: 45 }),
        ),
        hook({ hookName: 'Stop', name: 'tests-hook', durationMs: 300, exitCode: 2 }),
        hook({ hookName: 'Stop', name: 'on-stop', durationMs: 20, blocked: true }),
        hook({ hookName: 'PreToolUse:Bash', name: 'guard', blocked: true }),
      ],
    );
    expect(trail?.hookCount).toBe(29);
    expect(trail?.contextCount).toBe(2);
    expect(trail?.hookMs).toBe(24 * 45 + 320);
    expect(trail?.hooks).toEqual([
      {
        hookName: 'UserPromptSubmit',
        names: [{ name: 'review-trigger', count: 1 }],
        count: 2,
        durationMs: 0,
        contexts: ['самопроверка', 'ревью'],
      },
      {
        hookName: 'PostToolUse:Bash',
        names: [{ name: 'inject-project-rules', count: 24 }],
        count: 24,
        durationMs: 24 * 45,
        contexts: [],
      },
      {
        hookName: 'Stop',
        names: [
          { name: 'tests-hook', count: 1 },
          { name: 'on-stop', count: 1 },
        ],
        count: 2,
        durationMs: 320,
        contexts: [],
        failure: { exitCode: 2 },
      },
      {
        hookName: 'PreToolUse:Bash',
        names: [{ name: 'guard', count: 1 }],
        count: 1,
        durationMs: 0,
        contexts: [],
        failure: {},
      },
    ]);
  });

  it('пустой ход — строки нет', () => {
    expect(buildTurnTrail([])).toBeUndefined();
    expect(buildTurnTrail([bash('git status'), { name: 'Read', input: '{}' }])).toBeUndefined();
  });
});

const user = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: '2026-10-25T10:00:00.000Z',
  ...extra,
});
const assistant = (id: string, tools: { name: string; input: string }[], hooks?: HookTrace[]) =>
  ({
    id,
    role: 'assistant',
    blocks: tools.map((tool) => ({ type: 'tool', ...tool })),
    timestamp: '2026-10-25T10:00:01.000Z',
    ...(hooks ? { hooks } : {}),
  }) as ChatMessage;

describe('turnTrails — границы хода', () => {
  it('след ставится под последним ответом хода; слова посреди хода и уведомление его не делят', () => {
    const trails = turnTrails([
      user('u1', 'задание'),
      assistant('a1', [{ name: 'Skill', input: '{"skill":"deep-review"}' }]),
      user('q1', 'ещё вот что', { midTurn: true }),
      assistant('a2', [bash('pnpm test')], [hook({ hookName: 'Stop', name: 'on-stop' })]),
      user('n1', '<task-notification><status>completed</status></task-notification>'),
      assistant('a3', [bash('make build')]),
      user('u2', 'следующее'),
      assistant('a4', [bash('git log')]),
      user('u3', 'третье'),
      assistant('a5', [{ name: 'Skill', input: '{"skill":"commit-name"}' }]),
    ]);
    expect([...trails.keys()]).toEqual(['a3', 'a5']);
    expect(trails.get('a3')).toMatchObject({
      skills: ['deep-review'],
      scripts: [{ command: 'pnpm test' }, { command: 'make build' }],
      hookCount: 1,
    });
    expect(trails.get('a5')?.skills).toEqual(['commit-name']);
  });
});
