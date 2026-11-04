import { describe, expect, it } from 'vitest';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import { FROM_HUMAN_LINE, PLATFORM_MARKER } from '@agentdeck/contracts/core/user-layer';
import {
  HUMAN_ORIGIN_MARK,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import type { SseEvent } from '@entities/CoreTask';
import { chatCliOf, chatCliOptions, chatFields, chatLaunchCommands, chatTitle } from './chatStart';
import { coreChatEn } from '@shared/config/i18n/core-chat/en';
import { coreChatRu } from '@shared/config/i18n/core-chat/ru';
import {
  activeLaunchRefusal,
  carryRefusalLine,
  launchRefusalOfEvent,
  refusalLine,
} from './chatRefusal';
import { chatItems, chatStatusKey, chatStepOf, modelTurnOpen, sessionsOfStep } from './chatView';
import { followSession, freshAfterReconnect } from './sessionFollow';

/**
 * Модель чата ядра (этап 10, F2): поля оценки нового чата (на месте, грант на корень, CLI —
 * командой до запуска), лента из вида сеанса и читатель потока с повтором после обрыва.
 */

const ev = (offset: number, kind: SessionStreamEvent['kind'], data: unknown): SessionStreamEvent =>
  ({ offset, kind, data }) as SessionStreamEvent;

describe('new core chat: estimate fields and launch order', () => {
  it('a chat in the project root with the grant on that root; launch waits for the CLI choice', () => {
    const got = chatFields({ project: ' C:/w/app ', cli: 'qwen', text: 'Привет\nвторая строка' });
    if (!got.ok) throw new Error(got.problem);
    expect(estimateFieldsSchema.parse(got.fields)).toEqual(got.fields);
    expect(got.fields).toMatchObject({
      title: 'Привет',
      request: 'Привет\nвторая строка',
      repos: [{ path: 'C:/w/app', baseRef: null }],
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      placement: { kind: 'in-place', grant: { project: 'C:/w/app', ops: ['edit'] } },
    });
    expect(chatLaunchCommands('t1', 'qwen').map((c) => [c.kind, c.fields])).toEqual([
      ['set-cli', { scope: 'task', scopeId: 't1', adapter: 'qwen', timing: 'now' }],
      ['launch', {}],
    ]);
  });

  it('an empty project or message is named, nothing is sent; a long first line is cut', () => {
    expect(chatFields({ project: '', cli: 'claude', text: 'x' })).toEqual({
      ok: false,
      problem: 'project',
    });
    expect(chatFields({ project: '/p', cli: 'claude', text: '  ' })).toEqual({
      ok: false,
      problem: 'text',
    });
    expect(chatTitle('a'.repeat(200))).toHaveLength(80);
  });

  it('continuing a conversation: the chosen CLI asks for it; a new chat asks nothing; a bad id is named', () => {
    const id = '0d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
    const got = chatFields({ project: '/p', cli: 'claude', text: 'дальше', resume: id });
    if (!got.ok) throw new Error(got.problem);
    expect(estimateFieldsSchema.parse(got.fields)).toEqual(got.fields);
    expect(got.fields.resume).toEqual({ adapter: 'claude', conversationId: id });
    expect(got.fields.placement).toMatchObject({ kind: 'in-place' });
    // Просит именно выбранный CLI: разговор qwen подтверждает переходник qwen, а не Claude.
    const qwen = chatFields({ project: '/p', cli: 'qwen', text: 'дальше', resume: 'abc-1' });
    expect(qwen.ok && qwen.fields.resume).toEqual({ adapter: 'qwen', conversationId: 'abc-1' });
    const plain = chatFields({ project: '/p', cli: 'claude', text: 'x' });
    expect(plain.ok && 'resume' in plain.fields).toBe(false);
    for (const bad of ['../a', '', 'a/b', ' x']) {
      expect(chatFields({ project: '/p', cli: 'claude', text: 'x', resume: bad })).toEqual({
        ok: false,
        problem: 'resume',
      });
    }
  });

  it('the CLI from the address: any registry-shaped id goes to the core, which decides; junk does not', () => {
    for (const id of ['qwen', 'claude', 'codex', 'opencode', 'goose', 'gemini', 'kimi', 'aider']) {
      expect(chatCliOf(id)).toBe(id);
    }
    expect(chatCliOf(undefined)).toBeUndefined();
    expect(chatCliOf('')).toBeUndefined();
    expect(chatCliOf(7)).toBeUndefined();
    expect(chatCliOf('Codex')).toBeUndefined();
    expect(chatCliOf('../etc')).toBeUndefined();
    expect(chatCliOf('a'.repeat(41))).toBeUndefined();
  });

  it('CLI choice: panel providers in catalog order, Claude first while missing, the address pick kept', () => {
    expect(chatCliOptions(['claude', 'codex', 'qwen'], 'codex')).toEqual([
      'claude',
      'codex',
      'qwen',
    ]);
    expect(chatCliOptions([], 'claude')).toEqual(['claude']);
    expect(chatCliOptions(['codex'], 'goose')).toEqual(['claude', 'codex', 'goose']);
    expect(chatCliOptions(['claude', 'Bad Id'], 'claude')).toEqual(['claude']);
  });
});

describe('launch refusal of a chat CLI (no silent fallback to the old runner)', () => {
  const frame = (line: unknown): SseEvent => ({ data: JSON.stringify(line) }) as SseEvent;
  const compat = (seq: number, output: unknown) =>
    frame({ kind: 'decision', seq, data: { class: 'compat', output } });

  it('the compat decision with a closed-list code is read; other rows and junk are not', () => {
    expect(launchRefusalOfEvent(compat(12, { kind: 'refused', code: 'no_core_hook' }))).toEqual({
      seq: 12,
      code: 'no_core_hook',
      setting: null,
    });
    expect(
      launchRefusalOfEvent(
        compat(3, { kind: 'refused', code: 'bypass_setting', setting: 'dangerously-skip' }),
      ),
    ).toMatchObject({ code: 'bypass_setting', setting: 'dangerously-skip' });
    expect(launchRefusalOfEvent(compat(4, { kind: 'refused', code: 'made_up' }))).toBeNull();
    expect(launchRefusalOfEvent(compat(5, { kind: 'admitted' }))).toBeNull();
    expect(
      launchRefusalOfEvent(
        frame({
          kind: 'decision',
          seq: 6,
          data: { class: 'route', output: { kind: 'refused', code: 'no_core_hook' } },
        }),
      ),
    ).toBeNull();
    expect(launchRefusalOfEvent({ data: 'not json' } as SseEvent)).toBeNull();
  });

  it('a refusal stops counting once a session starts after it; an earlier session does not clear it', () => {
    const refusal = { seq: 10, code: 'no_core_hook' as const, setting: null };
    expect(activeLaunchRefusal(refusal, [{ startedSeq: 4 }] as never)).toBe(refusal);
    expect(
      activeLaunchRefusal(refusal, [{ startedSeq: 4 }, { startedSeq: 11 }] as never),
    ).toBeNull();
    expect(activeLaunchRefusal(null, [] as never)).toBeNull();
  });

  it('the screen line: explained codes by name, the rest generic with the code, a failed step verbatim', () => {
    expect(refusalLine({ seq: 1, code: 'no_core_hook', setting: null }, null)).toEqual({
      key: 'no_core_hook',
      params: { code: 'no_core_hook', setting: '' },
    });
    expect(refusalLine({ seq: 1, code: 'adapter_not_built', setting: null }, 'x')?.key).toBe(
      'adapter_not_built',
    );
    expect(refusalLine({ seq: 1, code: 'bypass_setting', setting: 'yolo' }, null)).toEqual({
      key: 'other',
      params: { code: 'bypass_setting', setting: 'yolo' },
    });
    expect(refusalLine(null, 'no-outcome: session refused')).toEqual({
      key: 'failed',
      params: { reason: 'no-outcome: session refused' },
    });
    expect(refusalLine(null, null)).toBeNull();
  });

  // s10 G13: отказ переноса набора панели — причина и выход своим текстом, не слова ядра.
  it('a kit carry refusal in the failed step reason gets its own line: hooks mode, MCP folder, missing folder', () => {
    expect(
      refusalLine(
        null,
        "process-start failed: launch-refused: session-carry-needs-layer-on: plugins and setting sources ride the human layer, this step runs it 'off' by its own mode",
      ),
    ).toEqual({ key: 'kitHooks', params: { mode: 'off' } });
    expect(
      refusalLine(
        null,
        "process-start failed: launch-refused: session-carry-plugin: plugin declares MCP servers (plugin.json mcpServers), outside the session's strict MCP list: /home/u/.agentdeck/kit/guards",
      ),
    ).toEqual({ key: 'kitMcp', params: { path: '/home/u/.agentdeck/kit/guards' } });
    expect(
      refusalLine(
        null,
        'process-start failed: launch-refused: session-carry-plugin: plugin dir missing: C:\\d\\kit',
      ),
    ).toEqual({ key: 'kitMissing', params: { path: 'C:\\d\\kit' } });
  });

  // s10 G14 p7: отказ локального слоя и CLI без поля переноса — свой текст на обоих языках, с
  // выходом; ни строка `failed` со словами ядра, ни ключ без перевода.
  it.each([
    [
      "process-start failed: launch-refused: session-carry-local-layer-needs-layer-on: the project layer is repository content, this step runs the human layer 'observe' (folder not trusted)",
      'layerUntrusted',
      {},
    ],
    [
      "process-start failed: launch-refused: session-carry-local-layer-needs-layer-on: the project layer is repository content, this step runs the human layer 'off'",
      'layerMode',
      { mode: 'off' },
    ],
    [
      'process-start failed: launch-refused: session-carry-local-layer-with-project: the local layer replaces the project setting source, the session must narrow setting sources without project',
      'layerSources',
      {},
    ],
    [
      'process-start failed: launch-refused: session-carry-local-layer-plugin: plugin dir missing: /w/app/.agent/local-layer/build/plugin',
      'layerBuild',
      { path: '/w/app/.agent/local-layer/build/plugin' },
    ],
    [
      'the panel layer does not fit the core session: the project local layer does not fit the core session: instructions Too big',
      'layerFit',
      { field: 'instructions' },
    ],
    [
      'session road refused: session-carry-unsupported: adapter qwen cannot carry localLayer — start the chat in a CLI that does, or drop the field',
      'carryUnsupported',
      { adapter: 'qwen', fields: 'localLayer' },
    ],
  ] as const)('s10 G14 p7: %s → %s, texted in ru and en', (reason, key, params) => {
    const line = refusalLine(null, reason);
    expect(line).toEqual({ key, params });
    expect(carryRefusalLine(reason)).toEqual({ key, params });
    for (const dict of [coreChatRu, coreChatEn]) {
      const text = dict.launchRefused[key];
      expect(text).not.toContain('session-carry-');
      for (const name of text.match(/\{\{(\w+)\}\}/g) ?? []) {
        expect(Object.keys(params)).toContain(name.slice(2, -2));
      }
    }
    expect(coreChatRu.launchRefused.layerUntrusted).toContain('«да»');
    expect(coreChatEn.launchRefused.layerUntrusted).toContain('mode «Off»');
  });
});

describe('chat feed from the session view', () => {
  it('text deltas join into one message; the tool result sits on its call; the human mark is dropped', () => {
    const items = chatItems([
      {
        sessionId: 's1',
        done: false,
        events: [
          ev(0, 'user-text', { text: 'Что в проекте?' }),
          ev(10, 'assistant-text', { text: 'Смотрю ' }),
          ev(20, 'assistant-text', { text: 'файлы.' }),
          ev(30, 'tool-call', { toolUseId: 'u1', name: 'Read', input: { file_path: 'a.ts' } }),
          ev(40, 'usage', { input: 1 }),
          ev(50, 'tool-result', { toolUseId: 'u1', isError: false }),
          ev(60, 'assistant-text', { text: 'Готово.' }),
          ev(70, 'turn-end', { isError: false }),
          ev(80, 'user-text', {
            text: `${HUMAN_ORIGIN_MARK} Message from the human to this step:\nещё`,
          }),
        ],
      },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      'human',
      'assistant',
      'tool',
      'assistant',
      'turn-end',
      'human',
    ]);
    expect(items[1]).toMatchObject({ text: 'Смотрю файлы.' });
    expect(items[2]).toMatchObject({
      tool: { name: 'Read', input: { file_path: 'a.ts' }, result: { isError: false } },
    });
    expect(items[5]).toMatchObject({ text: 'ещё' });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(modelTurnOpen(items)).toBe(true);
    expect(modelTurnOpen(items.slice(0, 5))).toBe(false);
  });

  it('the platform framing the adapter puts on every send (marker, from-human, human-origin) is not shown', () => {
    const items = chatItems([
      {
        sessionId: 's1',
        done: false,
        events: [
          // Начало чата — бриф шага с меткой платформы (markText в переходнике).
          ev(0, 'user-text', { text: `${PLATFORM_MARKER}\nход-1: привет` }),
          // Ход человека — доставка с меткой человека, обёрнутая markText(…, 'human').
          ev(10, 'user-text', {
            text: `${PLATFORM_MARKER}\n${FROM_HUMAN_LINE}\n${HUMAN_ORIGIN_MARK} Message from the human to this step:\nход-2\nвторая строка`,
          }),
        ],
      },
    ]);
    expect(items.map((i) => (i.kind === 'human' ? i.text : i.kind))).toEqual([
      'ход-1: привет',
      'ход-2\nвторая строка',
    ]);
  });

  it('the chat step and its sessions in start order (a resumed conversation continues in a new session)', () => {
    const view = {
      steps: [
        { stepId: 'a', stepKind: 'chat', startedSeq: 3 },
        { stepId: 'w', stepKind: 'work', startedSeq: 9 },
      ],
      sessions: [
        { sessionId: 's2', stepId: 'a', startedSeq: 20 },
        { sessionId: 's1', stepId: 'a', startedSeq: 5 },
        { sessionId: 'x', stepId: 'w', startedSeq: 10 },
      ],
    } as never;
    expect(chatStepOf(view)?.stepId).toBe('a');
    expect(sessionsOfStep(view, 'a').map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('status line: the most important true state wins; a closed chat with a dropped stream is closed', () => {
    const base = {
      taskMissing: false,
      refusal: null,
      launchRefused: false,
      closed: false,
      dropped: false,
      answering: false,
    };
    expect(chatStatusKey(base)).toBe('waiting');
    expect(chatStatusKey({ ...base, launchRefused: true, closed: true })).toBe('launch-refused');
    expect(chatStatusKey({ ...base, launchRefused: true, refusal: 403 })).toBe('refused');
    expect(chatStatusKey({ ...base, answering: true })).toBe('answering');
    expect(chatStatusKey({ ...base, answering: true, dropped: true })).toBe('dropped');
    expect(chatStatusKey({ ...base, dropped: true, closed: true })).toBe('closed');
    expect(chatStatusKey({ ...base, closed: true, refusal: 403 })).toBe('refused');
    expect(chatStatusKey({ ...base, refusal: 403, taskMissing: true })).toBe('missing');
  });
});

/** Ответ SSE из кадров; `hold` — поток не кончается сам (живой сеанс). */
function sse(frames: string[], hold = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (!hold) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const page = (next: number, events: SessionStreamEvent[], done = false) =>
  `id: ${next}\nevent: page\ndata: ${JSON.stringify({ events, next, done })}\n\n`;

describe('session stream reader', () => {
  it('a drop resumes with Last-Event-ID = cursor; the boundary turn shown before is not repeated; done stops', async () => {
    const human = ev(100, 'user-text', { text: 'второй ход' });
    const asked: (string | null)[] = [];
    const responses = [
      sse([
        page(100, [
          ev(0, 'user-text', { text: 'первый' }),
          ev(10, 'assistant-text', { text: 'A' }),
        ]),
        page(100, [human]),
      ]),
      sse([page(180, [human, ev(100, 'assistant-text', { text: 'B' })], true)]),
    ];
    const got: SessionStreamEvent[] = [];
    let doneSeen = false;
    const cursor = await followSession({
      url: '/x',
      signal: new AbortController().signal,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        asked.push((init.headers as Record<string, string>)['last-event-id'] ?? null);
        return responses.shift()!;
      }) as typeof fetch,
      sleep: async () => undefined,
      onEvents: (events, done) => {
        got.push(...events);
        doneSeen ||= done;
      },
    });
    expect(asked).toEqual([null, '100']);
    expect(got.map((e) => (e.data as { text: string }).text)).toEqual([
      'первый',
      'A',
      'второй ход',
      'B',
    ]);
    expect(doneSeen).toBe(true);
    expect(cursor).toBe(180);
  });

  it('boundary dedup keys follow the order at the cursor, so a second equal turn still shows', () => {
    const a = ev(5, 'user-text', { text: 'да' });
    expect(freshAfterReconnect([a], [a, a])).toEqual([a]);
    expect(freshAfterReconnect([], [a])).toEqual([a]);
  });
});
