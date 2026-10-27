import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Группа из двух сессий в раскладке CLI: прошлая (работа) с двумя субагентами и
 * текущая (правки) с одним; рядом — сессия другой группы того же родителя и
 * временный ключ без транскрипта. Время — минуты от начала дня.
 */
export const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 26, 8, minute)).toISOString();

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

const user = (minute: number, text: string) => ({
  type: 'user',
  timestamp: at(minute),
  message: { role: 'user', content: text },
});

const assistant = (minute: number, id: string, content: unknown[], tokens = 10) => ({
  type: 'assistant',
  timestamp: at(minute),
  message: {
    id,
    model: 'claude-opus-4-1',
    content,
    usage: {
      input_tokens: tokens,
      output_tokens: 1,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
    },
  },
});

const agentCall = (id: string, description: string) => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: { subagent_type: 'general-purpose', description, prompt: description },
});

const result = (minute: number, id: string, text: string) => ({
  type: 'user',
  timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

/** Файл субагента: `calls` вызовов Grep, ответы по одному на вызов. */
export function writeSubagent(
  sessionPath: string,
  agentId: string,
  toolUseId: string,
  description: string,
  calls: number,
): string {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description, toolUseId }),
  );
  const log = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(log, '');
  for (let index = 0; index < calls; index += 1) appendSubagentCall(log, index);
  return log;
}

export function appendSubagentCall(log: string, index: number): void {
  appendFileSync(
    log,
    line({
      type: 'assistant',
      isSidechain: true,
      timestamp: at(5 + index),
      message: {
        id: `${log.length}-s${index}`,
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'tool_use', id: `g${index}`, name: 'Grep', input: { pattern: `p${index}` } },
        ],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
  );
}

export interface GroupFixture {
  projectsDir: string;
  workPath: string;
  fixPath: string;
  workLog: string;
  links: Record<string, ChatLink>;
}

export function seedGroup(root: string): GroupFixture {
  const projectsDir = join(root, 'projects');
  const proj = join(projectsDir, 'C--qa-reports');
  mkdirSync(proj, { recursive: true });

  const workPath = join(proj, 's-work.jsonl');
  writeFileSync(
    workPath,
    [
      user(0, 'Сделай выгрузку отчётов'),
      // Один ответ модели — две строки с одним id: расход считается один раз.
      assistant(1, 'w1', [agentCall('toolu_w1', 'Найти модуль отчётов')], 40),
      assistant(1, 'w1', [agentCall('toolu_w2', 'Собрать выгрузку CSV')], 40),
      result(20, 'toolu_w1', 'Модуль: src/reports'),
      result(40, 'toolu_w2', 'Выгрузка готова, тесты зелёные'),
      assistant(41, 'w2', [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git status' } },
      ]),
      result(42, 'b1', 'On branch main'),
      assistant(45, 'w3', [{ type: 'text', text: 'Готово' }]),
    ]
      .map(line)
      .join(''),
  );
  writeSubagent(workPath, 'aw1', 'toolu_w1', 'Найти модуль отчётов', 2);
  const workLog = writeSubagent(workPath, 'aw2', 'toolu_w2', 'Собрать выгрузку CSV', 3);

  const fixPath = join(proj, 's-fix.jsonl');
  writeFileSync(
    fixPath,
    [
      user(60, 'Поправь замечания ревью'),
      assistant(61, 'f1', [agentCall('toolu_f1', 'Поправить фильтр дат')]),
    ]
      .map(line)
      .join(''),
  );
  writeSubagent(fixPath, 'af1', 'toolu_f1', 'Поправить фильтр дат', 1);

  writeFileSync(
    join(proj, 's-other.jsonl'),
    [user(0, 'Другая группа'), assistant(1, 'o1', [agentCall('toolu_o1', 'Чужой агент')])]
      .map(line)
      .join(''),
  );

  const link = (extra: Partial<ChatLink>): ChatLink => ({
    parentChatId: 'parent',
    createdAt: at(0),
    ...extra,
  });
  const links: Record<string, ChatLink> = {
    's-work': link({ groupIndex: 0, stage: 'work' }),
    'new-temp': link({ groupIndex: 0, stage: 'review' }),
    's-fix': link({ groupIndex: 0, stage: 'fix' }),
    's-other': link({ groupIndex: 1, stage: 'work' }),
  };
  return { projectsDir, workPath, fixPath, workLog, links };
}
