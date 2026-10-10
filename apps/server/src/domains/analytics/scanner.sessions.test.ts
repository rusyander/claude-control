import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAnalytics } from './scanner.ts';

/**
 * Что сканер отдаёт про каждую сессию: разбивку токенов, число запросов,
 * границы во времени (из них считается длительность), инструменты, заголовок —
 * и сессии каждого проекта. Строки собраны по образцу настоящего транскрипта
 * Claude Code: ответ модели пишется ОТДЕЛЬНОЙ строкой на блок (thinking, text,
 * tool_use), у всех одинаковые `message.id` и `requestId`, а `output_tokens`
 * растёт к последней строке; заголовок — запись `ai-title` без метки времени.
 */
describe('scanAnalytics: сессии', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-scan-sessions-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  // «Сейчас» берётся один раз: под нагрузкой два вызова Date.now() расходились
  // на миллисекунду, и сравнение длительности «ровно 45 минут» краснело.
  const base = Date.now() - 2 * 60 * 60 * 1000;

  /** Метка внутри окна: `minutes` минут назад от условного «сейчас» (2 часа назад). */
  function at(minutes: number): string {
    return new Date(base + minutes * 60 * 1000).toISOString();
  }

  function writeTranscript(project: string, file: string, entries: unknown[]): void {
    const dir = join(projectsDir, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${file}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  /**
   * Один ответ модели так, как его пишет CLI: строка на блок, usage повторён с
   * растущим выходом. Последний блок — tool_use, если инструмент задан.
   */
  function response(opts: {
    session: string;
    cwd: string;
    minute: number;
    n: number;
    tools?: string[];
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    model?: string;
  }): unknown[] {
    const blocks: Array<Record<string, unknown>> = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'ok' },
      ...(opts.tools ?? []).map((name, index) => ({
        type: 'tool_use',
        id: `toolu_${opts.n}_${index}`,
        name,
        input: {},
      })),
    ];
    const finalOutput = opts.output ?? 10;
    return blocks.map((block, index) => ({
      parentUuid: null,
      isSidechain: false,
      type: 'assistant',
      timestamp: at(opts.minute),
      sessionId: opts.session,
      cwd: opts.cwd,
      gitBranch: 'main',
      requestId: `req_${opts.session}_${opts.n}`,
      message: {
        id: `msg_${opts.session}_${opts.n}`,
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-opus-4-8',
        content: [block],
        usage: {
          input_tokens: opts.input ?? 2,
          // Выход растёт по блокам; полное число несёт последняя строка.
          output_tokens: index === blocks.length - 1 ? finalOutput : Math.ceil(finalOutput / 4),
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheCreation ?? 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: opts.cacheCreation ?? 0,
          },
        },
      },
    }));
  }

  const options = { days: 30, recentSessionsLimit: 25 };

  it('разбивка токенов, число запросов и границы сессии — по итоговому usage каждого ответа', async () => {
    writeTranscript('p', 's1', [
      ...response({
        session: 's1',
        cwd: '/work/a',
        minute: 0,
        n: 1,
        tools: ['Read'],
        input: 3,
        output: 100,
        cacheRead: 1000,
        cacheCreation: 500,
      }),
      ...response({
        session: 's1',
        cwd: '/work/a',
        minute: 45,
        n: 2,
        input: 5,
        output: 40,
        cacheRead: 2000,
        cacheCreation: 0,
      }),
    ]);

    const [session] = (await scanAnalytics(projectsDir, options)).recentSessions;
    expect(session!.totals).toEqual({
      input: 8,
      output: 140,
      cacheRead: 3000,
      cacheCreation: 500,
      total: 8 + 140 + 3000 + 500,
      // Два ответа, хотя строк в файле семь: ответ — это message.id + requestId.
      requests: 2,
    });
    // Длительность считается из этих двух границ: 45 минут между ответами.
    expect(new Date(session!.lastActivity).getTime() - new Date(session!.startedAt).getTime()).toBe(
      45 * 60 * 1000,
    );
  });

  // Решение 10.10: субагенты пишут свой транскрипт в `<сессия>/subagents/` — их
  // расход входит в сессию родителя (записи несут его sessionId) и в общий итог.
  it('транскрипты субагентов считаются в сессию родителя; другие вложенные папки — нет', async () => {
    writeTranscript('p', 's1', response({ session: 's1', cwd: '/work/a', minute: 0, n: 1 }));
    writeTranscript(
      join('p', 's1', 'subagents'),
      'agent-a1',
      response({ session: 's1', cwd: '/work/a', minute: 5, n: 2, output: 30 }).map((line) => ({
        ...(line as Record<string, unknown>),
        isSidechain: true,
        agentId: 'a1',
      })),
    );
    // Не транскрипт субагента — в счёт не идёт.
    writeTranscript(join('p', 's1', 'tool-results'), 'stray', [
      ...response({ session: 's1', cwd: '/work/a', minute: 6, n: 3, output: 999 }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.recentSessions).toHaveLength(1);
    expect(result.recentSessions[0]!.totals).toMatchObject({ output: 40, requests: 2 });
    expect(result.overall.output).toBe(40);
  });

  it('инструменты считаются по сессиям отдельно, по убыванию, список обрезан', async () => {
    writeTranscript('p', 's1', [
      ...response({
        session: 's1',
        cwd: '/work/a',
        minute: 0,
        n: 1,
        tools: ['Read', 'Read', 'Bash'],
      }),
      ...response({ session: 's1', cwd: '/work/a', minute: 1, n: 2, tools: ['Bash', 'Read'] }),
      ...response({
        session: 's1',
        cwd: '/work/a',
        minute: 2,
        n: 3,
        tools: ['Edit', 'Grep', 'Glob', 'Write'],
      }),
      ...response({ session: 's1', cwd: '/work/a', minute: 3, n: 4, tools: ['Bash'] }),
    ]);
    writeTranscript('p', 's2', [
      ...response({ session: 's2', cwd: '/work/a', minute: 10, n: 1, tools: ['WebFetch'] }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    const s1 = result.recentSessions.find((s) => s.sessionId === 's1')!;
    const s2 = result.recentSessions.find((s) => s.sessionId === 's2')!;

    // Bash 3, Read 3, затем одиночные по имени; пятый — предел, шестой отрезан.
    expect(s1.topTools).toEqual([
      { name: 'Bash', count: 3 },
      { name: 'Read', count: 3 },
      { name: 'Edit', count: 1 },
      { name: 'Glob', count: 1 },
      { name: 'Grep', count: 1 },
    ]);
    // Всего вызовов — все десять, а не только показанные пять.
    expect(s1.toolCalls).toBe(10);
    // Чужая сессия видит только свои инструменты.
    expect(s2.topTools).toEqual([{ name: 'WebFetch', count: 1 }]);
    expect(s2.toolCalls).toBe(1);
    // Общий топ по периоду по-прежнему сумма всех сессий.
    expect(result.topTools.find((tool) => tool.name === 'Bash')?.count).toBe(3);
    expect(result.topTools.find((tool) => tool.name === 'WebFetch')?.count).toBe(1);
  });

  it('сессия без инструментов не получает пустых полей', async () => {
    writeTranscript('p', 's1', [...response({ session: 's1', cwd: '/work/a', minute: 0, n: 1 })]);

    const [session] = (await scanAnalytics(projectsDir, options)).recentSessions;
    expect(session!.topTools).toBeUndefined();
    expect(session!.toolCalls).toBeUndefined();
    expect(session!.title).toBeUndefined();
  });

  it('инструменты вне периода в итог сессии не попадают', async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const inside = response({ session: 's1', cwd: '/work/a', minute: 0, n: 2, tools: ['Read'] });
    const outside = response({
      session: 's1',
      cwd: '/work/a',
      minute: 0,
      n: 1,
      tools: ['Bash', 'Bash'],
    }).map((line) => ({ ...(line as object), timestamp: old }));
    writeTranscript('p', 's1', [...outside, ...inside]);

    const [session] = (await scanAnalytics(projectsDir, { days: 7, recentSessionsLimit: 25 }))
      .recentSessions;
    expect(session!.topTools).toEqual([{ name: 'Read', count: 1 }]);
    expect(session!.totals.requests).toBe(1);
  });

  it('заголовок разговора берётся из ai-title без метки времени; побеждает последний', async () => {
    writeTranscript('p', 's1', [
      { type: 'ai-title', aiTitle: 'Первое название', sessionId: 's1' },
      ...response({ session: 's1', cwd: '/work/a', minute: 0, n: 1 }),
      { type: 'ai-title', aiTitle: 'Починить аналитику сессий', sessionId: 's1' },
    ]);
    writeTranscript('p', 's2', [...response({ session: 's2', cwd: '/work/a', minute: 5, n: 1 })]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.recentSessions.find((s) => s.sessionId === 's1')!.title).toBe(
      'Починить аналитику сессий',
    );
    // Заголовок соседней сессии на эту не переходит.
    expect(result.recentSessions.find((s) => s.sessionId === 's2')!.title).toBeUndefined();
  });

  it('у проекта есть свои сессии с итогами: новые первыми, чужие не попадают, предел 10', async () => {
    for (let index = 0; index < 12; index++) {
      writeTranscript('a', `a${index}`, [
        ...response({
          session: `a${index}`,
          cwd: '/work/a',
          minute: index,
          n: 1,
          output: 10 + index,
        }),
      ]);
    }
    writeTranscript('b', 'b0', [
      ...response({ session: 'b0', cwd: '/work/b', minute: 30, n: 1, tools: ['Bash'] }),
    ]);

    const result = await scanAnalytics(projectsDir, { days: 30, recentSessionsLimit: 3 });
    const a = result.byProject.find((p) => p.project.endsWith('/work/a'))!;
    const b = result.byProject.find((p) => p.project.endsWith('/work/b'))!;

    // Полное число сессий проекта — в `sessions`, список обрезан до последних десяти.
    expect(a.sessions).toBe(12);
    expect(a.sessionList).toHaveLength(10);
    expect(a.sessionList!.map((s) => s.sessionId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `a${11 - index}`),
    );
    // Итог сессии в списке проекта — её собственный, а не проекта.
    expect(a.sessionList![0]!.totals.output).toBe(10 + 11);
    expect(a.sessionList!.every((s) => s.project === a.project)).toBe(true);
    // Список проекта не зависит от общего предела `recentSessionsLimit`.
    expect(result.recentSessions).toHaveLength(3);
    expect(b.sessionList!.map((s) => s.sessionId)).toEqual(['b0']);
    expect(b.sessionList![0]!.topTools).toEqual([{ name: 'Bash', count: 1 }]);
  });

  it('если сессий проекта не больше предела, их итоги сходятся с итогом проекта', async () => {
    writeTranscript('a', 'x1', [
      ...response({
        session: 'x1',
        cwd: '/work/a',
        minute: 0,
        n: 1,
        input: 1,
        output: 11,
        cacheRead: 100,
      }),
    ]);
    writeTranscript('a', 'x2', [
      ...response({
        session: 'x2',
        cwd: '/work/a',
        minute: 9,
        n: 1,
        input: 2,
        output: 22,
        cacheCreation: 7,
      }),
    ]);

    const [project] = (await scanAnalytics(projectsDir, options)).byProject;
    const sum = project!.sessionList!.reduce((acc, s) => acc + s.totals.total, 0);
    expect(sum).toBe(project!.totals.total);
  });
});
