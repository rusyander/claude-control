import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseFindings,
  parseReply,
  resultOf,
  startAnalysis,
  type AnalysisOptions,
  usageOf,
  watchArgs,
  watchPrompt,
} from './analyzer.ts';
import type { WatchEvent } from './types.ts';

const block = (items: unknown): string => '```agentdeck-watch\n' + JSON.stringify(items) + '\n```';

describe('разбор ответа модели наблюдателя', () => {
  const ids = new Set(['aaaaaa111111']);

  it('берёт находку своего id и отбрасывает чужой id и неизвестный вердикт', () => {
    const found = parseFindings(
      block([
        {
          id: 'aaaaaa111111',
          title: 'Т',
          happened: 'Ч',
          context: '',
          verdict: 'confirmed',
          location: 'a.ts:1',
        },
        { id: 'zzzzzz999999', title: 'чужой', verdict: 'confirmed' },
        { id: 'aaaaaa111111', title: 'второй раз', verdict: 'maybe' },
      ]),
      ids,
    );
    expect([...found.keys()]).toEqual(['aaaaaa111111']);
    expect(found.get('aaaaaa111111')).toMatchObject({ verdict: 'confirmed', location: 'a.ts:1' });
  });

  it('«pending» от модели — не вердикт', () => {
    expect(parseFindings(block([{ id: 'aaaaaa111111', verdict: 'pending' }]), ids).size).toBe(0);
  });

  it('нет блока или битый JSON — ни одной находки, без исключения', () => {
    expect(parseFindings('просто текст', ids).size).toBe(0);
    expect(parseFindings('```agentdeck-watch\n[{oops\n```', ids).size).toBe(0);
  });

  it('расход — сумма по моделям, если CLI их назвал', () => {
    const usage = usageOf({
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 1,
        },
        'claude-sonnet-4-5': { inputTokens: 1, outputTokens: 1 },
      },
    });
    expect(usage).toEqual({
      input: 11,
      output: 3,
      cacheRead: 5,
      cacheCreation: 1,
      model: 'claude-haiku-4-5',
    });
  });

  it('результат находится и после строк-предупреждений в выводе', () => {
    const stdout = 'warning: something\n{"type":"result","result":"ok"}\n';
    expect(resultOf(stdout)?.result).toBe('ok');
  });

  it('флаги запуска: только чтение, без сессии, наши слои сняты', () => {
    const args = watchArgs('haiku', '/tmp/p.txt');
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config']),
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args.at(-2)).toBe('--append-system-prompt-file');
  });

  it('промпт несёт id, запрос и сообщение каждого сбоя', () => {
    const event: WatchEvent = {
      id: 'aaaaaa111111',
      ref: 'WR-1',
      entryClass: 'failure',
      severity: 'medium',
      source: 'client',
      kind: 'api-failure',
      method: 'POST',
      path: '/api/x',
      status: 0,
      route: '/settings',
      message: 'Network Error',
      firstSeen: 'a',
      lastSeen: 'b',
      count: 2,
      analyzedCount: 0,
    };
    const prompt = watchPrompt([event]);
    expect(prompt).toContain('id: aaaaaa111111');
    expect(prompt).toContain('request: POST /api/x -> 0');
    expect(prompt).toContain('panel route: /settings');
    // Известные разделы — списком, чтобы модель ссылалась, а не дублировала.
    const withKnown = watchPrompt(
      [event],
      [{ ref: 'WR-7', entryClass: 'remark', title: 'Флаг не сбрасывается', location: 'a.ts:3' }],
    );
    expect(withKnown).toContain('- WR-7 [remark] Флаг не сбрасывается @ a.ts:3');
    expect(prompt).not.toContain('Already in the report');
    // Ошибка провайдера: модель видит хвост stderr, а не только код выхода.
    const exited = watchPrompt([
      { ...event, kind: 'cli-exit', output: 'API Error: 529 overloaded_error' },
    ]);
    expect(exited).toContain('cli stderr (tail):\nAPI Error: 529 overloaded_error');
  });

  it('замечания, важность, причина и «та же причина» — только на известное', () => {
    const reply = [
      '```agentdeck-watch',
      JSON.stringify([
        {
          id: 'aaaaaa111111',
          title: 'т',
          happened: 'х',
          rootCause: 'причина',
          steps: 'шаги',
          verdict: 'confirmed',
          severity: 'high',
          location: 'a.ts:1',
          sameAs: 'WR-3',
        },
        { id: 'bbbbbb222222', title: 'т2', verdict: 'unclear', severity: 'bogus', sameAs: 'WR-99' },
        {
          kind: 'remark',
          title: 'р1',
          explanation: 'почему',
          severity: 'medium',
          location: 'b.ts:9',
        },
        { kind: 'remark', title: 'без объяснения' },
        { kind: 'remark', title: 'р2', explanation: 'е', sameAs: 'WR-99' },
        { kind: 'remark', title: 'р3', explanation: 'е' },
        { kind: 'remark', title: 'р4 сверх потолка', explanation: 'е' },
      ]),
      '```',
    ].join('\n');
    const parsed = parseReply(reply, new Set(['aaaaaa111111', 'bbbbbb222222']), new Set(['WR-3']));
    expect(parsed.findings.get('aaaaaa111111')).toMatchObject({
      rootCause: 'причина',
      steps: 'шаги',
      severity: 'high',
    });
    // Неизвестная важность — не слово модели; выдуманная ссылка ничего не сливает.
    expect(parsed.findings.get('bbbbbb222222')?.severity).toBeUndefined();
    expect([...parsed.merges]).toEqual([['aaaaaa111111', 'WR-3']]);
    expect(parsed.remarks.map((remark) => remark.title)).toEqual(['р1', 'р2', 'р3']);
    expect(parsed.remarks[0]).toMatchObject({ severity: 'medium', location: 'b.ts:9' });
    expect(parsed.remarks[1]!.sameAs).toBeUndefined();
    expect(parsed.remarks[2]!.severity).toBe('low');
  });
});

describe('наблюдатель: ответ CLI и отказы разбора', () => {
  const ids = new Set(['aaaaaa111111']);

  it('результат — объект с type: result, а не последняя JSON-строка любого вида', () => {
    const stdout = '{"type":"result","result":"ok"}\n{"type":"warning","message":"late"}\n';
    expect(resultOf(stdout)?.result).toBe('ok');
  });

  it('ограда кода внутри fix не обрывает блок ответа', () => {
    const reply = block([
      {
        id: 'aaaaaa111111',
        title: 'T',
        happened: 'H',
        context: '',
        verdict: 'confirmed',
        fix: 'Replace with:\n```ts\nconst a = 1;\n```\ndone',
      },
    ]);
    const found = parseFindings(reply, ids);
    expect(found.get('aaaaaa111111')?.fix).toContain('const a = 1;');
  });

  /** «CLI» прогона — живой node, чья команда не зависит от флагов наблюдателя. */
  const fakeCli = (code: string): AnalysisOptions['spawnImpl'] =>
    ((_command: string, _args: readonly string[], options: SpawnOptions) =>
      nodeSpawn(process.execPath, ['-e', code], options)) as AnalysisOptions['spawnImpl'];
  const event = { id: 'aaaaaa111111' } as WatchEvent;

  it('таймаут и выход без ответа названы на языке панели', async () => {
    const slow = startAnalysis({
      command: process.execPath,
      cwd: process.cwd(),
      events: [event],
      spawnImpl: fakeCli('setInterval(() => {}, 1000)'),
      timeoutMs: 300,
      language: 'en',
    });
    expect((await slow.done).error).toMatch(/^The analysis did not finish/);

    const silent = startAnalysis({
      command: process.execPath,
      cwd: process.cwd(),
      events: [event],
      spawnImpl: fakeCli('process.stdin.resume(); process.stdin.on("end", () => process.exit(3))'),
      language: 'en',
    });
    expect((await silent.done).error).toBe('The CLI exited with code 3 without a reply.');
  });
});
