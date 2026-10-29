import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from './agent-history.fixture.ts';

/**
 * Сессия, расход которой посчитан руками в тесте: главный агент с повторным
 * чтением, отказом хука, ошибкой, большим результатом и субагентом; ответы
 * CLI пишет несколькими строками с одним id — итог несёт последняя.
 */

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const answer = (
  minute: number,
  id: string,
  content: unknown[],
  usage: Usage,
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  timestamp: at(minute),
  ...extra,
  message: {
    id,
    model: extra.isSidechain ? 'claude-sonnet-4-6' : 'claude-opus-4-1',
    content,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cacheRead,
      cache_creation_input_tokens: usage.cacheCreation,
    },
    ...(extra.stop ? { stop_reason: extra.stop } : {}),
  },
});

const use = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

const reply = (minute: number, id: string, text: string, isError = false, sidechain = false) => ({
  type: 'user',
  timestamp: at(minute),
  ...(sidechain ? { isSidechain: true } : {}),
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

const u = (input: number, output: number, cacheRead: number, cacheCreation: number): Usage => ({
  input,
  output,
  cacheRead,
  cacheCreation,
});

const BIG_RESULT = 'x'.repeat(12_000);
export const DENIAL_TEXT = 'PreToolUse:Bash hook error: [destructive-guard] rm -rf запрещён';

/** Сессия `s-exact` в своём проекте; вернёт каталог проектов и путь транскрипта. */
export function seedExact(root: string): { projectsDir: string; path: string } {
  const projectsDir = join(root, 'projects');
  const proj = join(projectsDir, 'C--qa-exact');
  mkdirSync(proj, { recursive: true });
  const path = join(proj, 's-exact.jsonl');
  writeFileSync(
    path,
    [
      { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Проверь отчёты' } },
      // Ответ m1 — две строки: промежуточный расход заменяется итоговым.
      answer(1, 'm1', [{ type: 'thinking', thinking: 'план' }], u(100, 1, 1000, 50)),
      answer(1, 'm1', [use('r1', 'Read', { file_path: '/a.ts' })], u(100, 10, 1000, 50)),
      reply(2, 'r1', BIG_RESULT),
      answer(3, 'm2', [use('r2', 'Read', { file_path: '/a.ts' })], u(200, 20, 2000, 0)),
      reply(5, 'r2', 'ok'),
      answer(6, 'm3', [use('b1', 'Bash', { command: 'rm -rf x' })], u(300, 30, 3000, 0)),
      reply(6, 'b1', DENIAL_TEXT, true),
      answer(7, 'm4', [use('b2', 'Bash', { command: 'false' })], u(400, 40, 4000, 5)),
      reply(8, 'b2', 'exit 1', true),
      answer(
        9,
        'm5',
        [
          use('toolu_x1', 'Agent', {
            subagent_type: 'general-purpose',
            description: 'Проверить тесты',
            prompt: 'Проверить тесты',
          }),
        ],
        u(500, 50, 5000, 0),
      ),
      reply(30, 'toolu_x1', 'Тесты зелёные'),
      answer(31, 'm6', [{ type: 'text', text: 'Готово' }], u(600, 60, 6000, 0), {
        stop: 'end_turn',
      }),
    ]
      .map(line)
      .join(''),
  );

  const dir = join(proj, 's-exact', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'agent-ax1.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'Проверить тесты',
      toolUseId: 'toolu_x1',
    }),
  );
  const side = { isSidechain: true };
  writeFileSync(
    join(dir, 'agent-ax1.jsonl'),
    [
      {
        type: 'user',
        isSidechain: true,
        timestamp: at(10),
        message: { role: 'user', content: 'Проверить тесты' },
      },
      answer(11, 's1', [use('g1', 'Read', { file_path: '/t.ts' })], u(11, 2, 300, 7), side),
      reply(12, 'g1', 'ok', false, true),
      answer(13, 's2', [use('g2', 'Read', { file_path: '/t.ts' })], u(13, 3, 400, 0), side),
      reply(13, 'g2', 'PreToolUse:Read hook error: [pre-tool-dispatch] re-read denied', true, true),
      answer(14, 's3', [{ type: 'text', text: 'Тесты' }], u(17, 1, 500, 0), side),
      answer(14, 's3', [{ type: 'text', text: 'зелёные' }], u(17, 5, 500, 0), side),
    ]
      .map(line)
      .join(''),
  );
  return { projectsDir, path };
}

/**
 * Главный транскрипт больше 4 МБ (порог, за которым разбор чата читает только
 * начало и хвост): `calls` вызовов Bash, у каждого результат в 2000 символов.
 */
export function seedLarge(root: string, calls: number): { projectsDir: string; path: string } {
  const projectsDir = join(root, 'projects');
  const proj = join(projectsDir, 'C--qa-large');
  mkdirSync(proj, { recursive: true });
  const path = join(proj, 's-large.jsonl');
  const padding = 'y'.repeat(2000);
  const parts = [
    line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Большой ход' } }),
  ];
  for (let index = 0; index < calls; index += 1) {
    const id = `c${index}`;
    parts.push(
      line(answer(1, `L${index}`, [use(id, 'Bash', { command: `echo ${index}` })], u(1, 1, 0, 0))),
    );
    parts.push(line(reply(2, id, padding)));
  }
  writeFileSync(path, parts.join(''));
  return { projectsDir, path };
}
