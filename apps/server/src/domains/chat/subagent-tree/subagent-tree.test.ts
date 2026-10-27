import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestAgentLog, resetAgentDigestCache } from './agent-digest.ts';
import { readAgentTranscript, readChatProgressWithTree } from './subagent-tree.ts';

/**
 * Дерево агентов по файлам CLI: главный транскрипт плюс
 * `<сессия>/subagents/agent-<id>.jsonl` и `.meta.json` каждого субагента.
 * Раскладка и поля записей — как у claude 2.1.3xx; данные выдуманы.
 */

const SESSION = 'sess-tree';
let root: string;
let projects: string;
let agentsDir: string;

const line = (record: object): string => `${JSON.stringify(record)}\n`;

const use = (id: string, name: string, input: object, msg: string, model = 'claude-haiku-4-5') =>
  line({
    type: 'assistant',
    isSidechain: true,
    timestamp: '2026-10-25T10:01:00.000Z',
    message: {
      id: msg,
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id, name, input }],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 5,
      },
    },
  });

const result = (id: string, text: string, isError = false) =>
  line({
    type: 'user',
    isSidechain: true,
    timestamp: '2026-10-25T10:02:00.000Z',
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

const say = (text: string, msg: string) =>
  line({
    type: 'assistant',
    isSidechain: true,
    timestamp: '2026-10-25T10:03:00.000Z',
    message: {
      id: msg,
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 50, output_tokens: 20 },
    },
  });

const prompt = (text: string) =>
  line({
    type: 'user',
    isSidechain: true,
    timestamp: '2026-10-25T10:00:00.000Z',
    message: { role: 'user', content: text },
  });

function writeAgent(agentId: string, meta: object, log: string): string {
  writeFileSync(join(agentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  const path = join(agentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(path, log);
  return path;
}

/** Главный транскрипт: два вызова Agent, первый закончен, второй в фоне. */
function writeMain(): void {
  const main = [
    line({ type: 'user', message: { role: 'user', content: 'go' } }),
    line({
      type: 'assistant',
      timestamp: '2026-10-25T10:00:00.000Z',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-a',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Найти отчёты' },
          },
          {
            type: 'tool_use',
            id: 'tu-b',
            name: 'Agent',
            input: { subagent_type: 'general-purpose', description: 'Ревью' },
          },
        ],
      },
    }),
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-a', content: 'нашёл' },
          {
            type: 'tool_result',
            tool_use_id: 'tu-b',
            content: 'Async agent launched successfully',
          },
        ],
      },
    }),
  ].join('');
  writeFileSync(join(projects, 'p', `${SESSION}.jsonl`), main);
}

beforeEach(() => {
  resetAgentDigestCache();
  root = mkdtempSync(join(tmpdir(), 'cc-subtree-'));
  projects = join(root, 'projects');
  agentsDir = join(projects, 'p', SESSION, 'subagents');
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('сводка субагента по его транскрипту', () => {
  it('модель, вызовы, расход по уникальным ответам, последнее действие и шаги', () => {
    const path = writeAgent(
      'aa1',
      { toolUseId: 'tu-a' },
      prompt('Найди отчёты') +
        use('t1', 'Grep', { pattern: 'renderReport' }, 'msg-1') +
        // Тот же ответ модели второй записью (CLI пишет блоки отдельно) — расход один раз.
        use('t2', 'Read', { file_path: 'src/a.ts' }, 'msg-1') +
        result('t1', 'src/a.ts:1') +
        result('t2', 'boom', true) +
        say('Готово: отчёты в src/a.ts', 'msg-2'),
    );
    const digest = digestAgentLog(path);
    expect(digest?.model).toBe('claude-haiku-4-5');
    expect(digest?.prompt).toBe('Найди отчёты');
    expect(digest?.toolCalls).toBe(2);
    expect(digest?.tokens).toEqual({ input: 150, output: 30, cacheRead: 1000, cacheCreation: 5 });
    expect(digest?.lastAction).toBe('Готово: отчёты в src/a.ts');
    expect(digest?.ended).toBe(true);
    expect(digest?.openTool).toBeUndefined();
    const tools = digest?.steps.filter((step) => step.kind === 'tool');
    expect(tools?.map((step) => [step.name, step.summary, step.result, step.isError])).toEqual([
      ['Grep', 'renderReport', 'src/a.ts:1', undefined],
      ['Read', 'src/a.ts', 'boom', true],
    ]);
  });

  it('идущий: открытый вызов — «что делает сейчас», ход не окончен', () => {
    const path = writeAgent(
      'aa2',
      {},
      prompt('x') + use('t1', 'Bash', { command: 'pnpm test' }, 'msg-1'),
    );
    const digest = digestAgentLog(path);
    expect(digest?.ended).toBe(false);
    expect(digest?.openTool).toMatchObject({ name: 'Bash', summary: 'pnpm test' });
    expect(digest?.lastAction).toBe('Bash: pnpm test');
  });

  it('дочитывает дописанное, не теряя прочитанного; недописанная строка ждёт конца', () => {
    const path = writeAgent('aa3', {}, prompt('x') + use('t1', 'Grep', { pattern: 'a' }, 'msg-1'));
    expect(digestAgentLog(path)?.toolCalls).toBe(1);
    const next = use('t2', 'Glob', { pattern: '**' }, 'msg-2');
    // Половина строки: разбор её не трогает, пока не придёт перевод строки.
    appendFileSync(path, next.slice(0, 40));
    expect(digestAgentLog(path)?.toolCalls).toBe(1);
    appendFileSync(path, next.slice(40));
    const digest = digestAgentLog(path);
    expect(digest?.toolCalls).toBe(2);
    expect(digest?.steps.map((step) => step.name)).toEqual(['Grep', 'Glob']);
  });

  it('переписанный короче файл читается заново', () => {
    const path = writeAgent(
      'aa4',
      {},
      prompt('x') + use('t1', 'Grep', { pattern: 'a' }, 'msg-1') + use('t2', 'Grep', {}, 'msg-2'),
    );
    expect(digestAgentLog(path)?.toolCalls).toBe(2);
    writeFileSync(path, prompt('y'));
    const digest = digestAgentLog(path);
    expect(digest?.toolCalls).toBe(0);
    expect(digest?.prompt).toBe('y');
  });
});

describe('дерево агентов разговора', () => {
  it('узел получает id, модель и расход своего файла; вложенный — родителя; потерянный — место по meta', () => {
    writeMain();
    writeAgent(
      'aaa',
      { agentType: 'Explore', toolUseId: 'tu-a' },
      prompt('Найди') +
        use('ta1', 'Grep', { pattern: 'x' }, 'ma1') +
        result('ta1', 'ok') +
        say('итог', 'ma2'),
    );
    writeAgent(
      'bbb',
      { agentType: 'general-purpose', toolUseId: 'tu-b', model: 'claude-sonnet-4-5' },
      prompt('Ревью') +
        use(
          'tb-nested',
          'Agent',
          { subagent_type: 'Explore', description: 'Тесты' },
          'mb1',
          'claude-sonnet-4-5',
        ) +
        result('tb-nested', 'тесты есть') +
        use('tb2', 'Bash', { command: 'pnpm vitest' }, 'mb2', 'claude-sonnet-4-5'),
    );
    writeAgent(
      'ccc',
      { agentType: 'Explore', toolUseId: 'tb-nested', spawnDepth: 2 },
      prompt('Тесты') + say('есть', 'mc1'),
    );
    writeAgent(
      'ddd',
      { agentType: 'Plan', description: 'Потерянный', toolUseId: 'tu-gone', finished: true },
      prompt('План') + say('план', 'md1'),
    );
    writeAgent('eee', { agentType: 'Plan', toolUseId: 'tu-gone-2' }, prompt('Ещё идёт'));

    const { agents } = readChatProgressWithTree(projects, SESSION);
    const by = (agentId: string) => agents.find((agent) => agent.agentId === agentId);

    expect(agents.map((agent) => agent.agentId)).toEqual(['aaa', 'bbb', 'ccc', 'ddd', 'eee']);
    expect(by('aaa')).toMatchObject({
      id: 'tu-a',
      status: 'done',
      model: 'claude-haiku-4-5',
      toolCalls: 1,
      lastAction: 'итог',
      endedAt: '2026-10-25T10:03:00.000Z',
    });
    expect(by('aaa')?.parentId).toBeUndefined();
    expect(by('bbb')).toMatchObject({
      status: 'running',
      background: true,
      model: 'claude-sonnet-4-5',
      toolCalls: 2,
      activity: { name: 'Bash', summary: 'pnpm vitest' },
    });
    expect(by('bbb')?.endedAt).toBeUndefined();
    expect(by('ccc')).toMatchObject({
      id: 'tb-nested',
      parentId: 'tu-b',
      status: 'done',
      kind: 'Explore',
      description: 'Тесты',
    });
    expect(by('ddd')).toMatchObject({
      id: 'tu-gone',
      kind: 'Plan',
      description: 'Потерянный',
      status: 'done',
    });
    expect(by('eee')).toMatchObject({ status: 'running', description: 'Ещё идёт' });
  });

  it('без файлов субагентов — прежний плоский список', () => {
    writeMain();
    const { agents } = readChatProgressWithTree(projects, SESSION);
    expect(agents.map((agent) => [agent.id, agent.agentId])).toEqual([
      ['tu-a', undefined],
      ['tu-b', undefined],
    ]);
  });

  it('meta с id, из которого собирается путь, пропускается', () => {
    writeMain();
    writeFileSync(join(agentsDir, 'agent-..%2Fx.meta.json'), JSON.stringify({ toolUseId: 'tu-a' }));
    const { agents } = readChatProgressWithTree(projects, SESSION);
    expect(agents.every((agent) => agent.agentId === undefined)).toBe(true);
  });
});

describe('ход субагента окном', () => {
  beforeEach(() => {
    writeMain();
    writeAgent(
      'aaa',
      { agentType: 'Explore', description: 'Найти отчёты', toolUseId: 'tu-a' },
      prompt('Найди') +
        use('t1', 'Grep', { pattern: '1' }, 'm1') +
        use('t2', 'Grep', { pattern: '2' }, 'm2') +
        use('t3', 'Grep', { pattern: '3' }, 'm3'),
    );
  });

  it('последние шаги, сдвиг от конца и признак «есть раньше»', () => {
    const last = readAgentTranscript(projects, SESSION, 'aaa', { limit: 2, offset: 0 });
    expect(last).toMatchObject({
      agentId: 'aaa',
      kind: 'Explore',
      description: 'Найти отчёты',
      prompt: 'Найди',
      total: 3,
      hasMore: true,
    });
    expect(last?.steps.map((step) => step.summary)).toEqual(['2', '3']);
    const earlier = readAgentTranscript(projects, SESSION, 'aaa', { limit: 2, offset: 2 });
    expect(earlier?.steps.map((step) => step.summary)).toEqual(['1']);
    expect(earlier?.hasMore).toBe(false);
  });

  it('чужой id и путь вместо id — нет хода', () => {
    expect(readAgentTranscript(projects, SESSION, 'nope', { limit: 5, offset: 0 })).toBeUndefined();
    expect(
      readAgentTranscript(projects, SESSION, '../../x', { limit: 5, offset: 0 }),
    ).toBeUndefined();
    expect(readAgentTranscript(projects, 'other', 'aaa', { limit: 5, offset: 0 })).toBeUndefined();
  });
});
