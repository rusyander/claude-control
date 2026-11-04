import { describe, expect, it } from 'vitest';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import {
  parseEstimateBody,
  taskAttachmentBodySchema,
  taskAttachmentsPath,
  type EstimateFields,
} from '@agentdeck/contracts/core/estimate';
import { randomUUID7, type CoreCaller } from '../../core-ask/core-ask.ts';
import type { CoreForward } from '../../core-proxy/core-proxy.ts';
import { createCoreChatPort } from './core-chat-port.ts';

/**
 * Ручки ядра хода чата: тело каждой команды и оценки судит та же схема, что у живого ядра
 * (`parseCommand`, `parseEstimateBody`) — конверт, который ядро отвергло бы, здесь красный.
 * Подменена только граница сети (`call`), сборка тел и разбор ответов — настоящие.
 */

function fakeCaller(
  reply: (forward: CoreForward) => Response,
): CoreCaller & { seen: CoreForward[] } {
  const seen: CoreForward[] = [];
  return {
    seen,
    call: async (forward) => {
      seen.push(forward);
      return reply(forward);
    },
    proof: async () => ({ nonce: 'n-1', page: randomUUID7() }),
    cmdId: randomUUID7,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FIELDS: EstimateFields = {
  title: 't',
  request: 'r',
  repos: [{ path: 'C:/p', baseRef: null }],
  scenario: { preset: 'chat' },
  launchPolicy: 'confirm',
  ciWait: false,
  placement: { kind: 'in-place', grant: { project: 'C:/p', ops: ['edit'] } },
  resume: { adapter: 'claude', conversationId: 'conv-1' },
} as EstimateFields;

describe('core chat port — request shapes judged by the core schemas', () => {
  it('estimate body passes the core estimate schema; refused estimate names the failed road', async () => {
    const taskId = randomUUID7();
    const caller = fakeCaller((f) => {
      const parsed = parseEstimateBody(f.body);
      if (!parsed.ok) return json(400, { code: 'bad-estimate', issues: parsed.issues });
      return json(202, {
        taskId,
        state: 'refused',
        preflight: [{ road: 'grant', status: 'failed', detail: 'outside project' }],
        problems: [],
      });
    });
    const out = await createCoreChatPort(caller).estimate(FIELDS);
    expect(caller.seen[0]).toMatchObject({ method: 'POST', path: '/v1/estimate' });
    expect(out).toEqual({
      ok: false,
      code: 'estimate-refused',
      taskId,
      message: 'grant: outside project',
    });
  });

  // s10 G12 p7: 422 до задачи — причины ядра без его русской шапки «Задача не создана»: они идут в
  // текст чата под шаблоном панели, а шапка там уже своя (и на английском интерфейсе — английская).
  it('a 422 estimate refusal before any task carries the core problems only, not the core header', async () => {
    const caller = fakeCaller(() =>
      json(422, {
        code: 'estimate-refused',
        error: 'Задача не создана',
        problems: ['C:/p: base default branch not found', 'C:/q: not a git repository'],
      }),
    );
    expect(await createCoreChatPort(caller).estimate(FIELDS)).toEqual({
      ok: false,
      code: 'estimate-refused',
      message: 'C:/p: base default branch not found; C:/q: not a git repository',
    });
    // Иной отказ (не оценки) — как был: слова ядра целиком.
    const other = fakeCaller(() => json(403, { code: 'forbidden', error: 'proof stale' }));
    expect(await createCoreChatPort(other).estimate(FIELDS)).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'proof stale',
    });
  });

  it('s10 G11: attachments ride the estimate body (core schema); attach posts one file to the task route and returns the core path', async () => {
    const taskId = randomUUID7();
    const caller = fakeCaller((f) => {
      if (f.path === '/v1/estimate') {
        const parsed = parseEstimateBody(f.body);
        if (!parsed.ok) return json(400, { code: 'bad-estimate', issues: parsed.issues });
        return json(202, { taskId, state: 'estimated', preflight: [], problems: [] });
      }
      const body = taskAttachmentBodySchema.safeParse(f.body);
      if (!body.success) return json(400, { code: 'bad-attachment' });
      if (body.data.attachment.name === 'x.exe') {
        return json(400, { code: 'attachment-invalid', problems: ['x.exe: not a supported file'] });
      }
      return json(200, {
        file: `C:/core/t/attachments/1/${body.data.attachment.name}`,
        name: 'a.png',
        bytes: 3,
      });
    });
    const port = createCoreChatPort(caller);
    const shot = { name: 'a.png', base64: 'AQID' };
    expect(await port.estimate(FIELDS, undefined, [shot])).toEqual({ ok: true, taskId });
    expect((caller.seen[0]!.body as { attachments: unknown }).attachments).toEqual([shot]);
    expect(await port.attach(taskId, shot)).toEqual({
      ok: true,
      file: 'C:/core/t/attachments/1/a.png',
    });
    expect(caller.seen[1]).toMatchObject({ method: 'POST', path: taskAttachmentsPath(taskId) });
    expect(await port.attach(taskId, { name: 'x.exe', base64: 'AQID' })).toEqual({
      ok: false,
      code: 'attachment-invalid',
      message: 'x.exe: not a supported file',
    });
  });

  it('G6: an estimate with the panel layer carry passes the core schema; env values ride the body, not the fields', async () => {
    const taskId = randomUUID7();
    const caller = fakeCaller((f) => {
      const parsed = parseEstimateBody(f.body);
      if (!parsed.ok) return json(400, { code: 'bad-estimate', issues: parsed.issues });
      return json(202, { taskId, state: 'estimated', preflight: [], problems: [] });
    });
    const fields = {
      ...FIELDS,
      session: {
        append: 'TESTS_LINE\n\nKIT_BLOCK',
        plugins: ['C:/kits/rules'],
        settingSources: ['project', 'local'],
        skills: 'off',
        mcp: 'core',
        builtinTools: ['Read', 'Grep'],
        env: ['AGENTDECK_TESTS_NOTE', 'AGENTDECK_KIT_VARIANT'],
      },
    } as EstimateFields;
    const env = { AGENTDECK_TESTS_NOTE: '1', AGENTDECK_KIT_VARIANT: 'light' };
    const out = await createCoreChatPort(caller).estimate(fields, env);
    expect(out).toMatchObject({ ok: true, taskId });
    const body = caller.seen[0]!.body as { fields: EstimateFields; env: Record<string, string> };
    expect(body.env).toEqual(env);
    expect(JSON.stringify(body.fields)).not.toContain('light');
    // Сырой путь плагина без корня — схема ядра отвергает, а не принимает.
    const bad = await createCoreChatPort(caller).estimate({
      ...fields,
      session: { plugins: ['kits/rules'] },
    } as EstimateFields);
    expect(bad).toMatchObject({ ok: false });
  });

  it.each([
    ['set-cli', { scope: 'task', adapter: 'claude', timing: 'now' }],
    ['set-model', { scope: 'task', model: 'opus', effort: null, timing: 'now' }],
    ['launch', {}],
    ['message-to-step', { stepId: randomUUID7(), text: 'дальше' }],
    ['cancel', { reason: 'stopped by the human in the panel' }],
    ['answer', { askId: randomUUID7(), answer: 'grant' }],
  ] as const)('%s envelope passes parseCommand', async (kind, base) => {
    const taskId = randomUUID7();
    const fields = 'scope' in base ? { ...base, scopeId: taskId } : base;
    const caller = fakeCaller((f) => {
      const parsed = parseCommand(f.body);
      if (!parsed.ok) return json(400, { code: 'bad-command', issues: parsed.issues });
      return json(202, { cmdId: parsed.command.cmdId, status: 'applied', seq: 3 });
    });
    const out = await createCoreChatPort(caller).command(taskId, kind, fields);
    expect(out).toMatchObject({ status: 'applied', seq: 3 });
  });

  it('a schema refusal (400) comes back as a rejected outcome with the core code', async () => {
    const caller = fakeCaller(() =>
      json(400, {
        code: 'bad-command',
        error: 'bad',
        issues: [{ path: 'fields.reason', message: 'Required' }],
      }),
    );
    const out = await createCoreChatPort(caller).command(randomUUID7(), 'cancel', {});
    expect(out).toMatchObject({
      status: 'rejected',
      code: 'bad-command',
      reason: 'bad: fields.reason: Required',
    });
  });

  it('view: 404 is null; session follow reads SSE pages from the cursor', async () => {
    const taskId = randomUUID7();
    const sessionId = randomUUID7();
    const page = { taskId, sessionId, adapter: 'claude', events: [], next: 40, done: true };
    const caller = fakeCaller((f) => {
      if (f.path.endsWith('/stream?follow=1&from=30')) {
        return new Response(`: open\n\nevent: page\nid: 40\ndata: ${JSON.stringify(page)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return json(404, {});
    });
    const port = createCoreChatPort(caller);
    expect(await port.view(taskId)).toBeNull();
    const pages = [];
    for await (const p of port.follow(taskId, sessionId, 30, new AbortController().signal)) {
      pages.push(p);
    }
    expect(pages).toEqual([page]);
  });
});
