import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { describe, expect, it } from 'vitest';
import { startCoreForeignChat } from './core-foreign-start.ts';

const TASK = '01890000-0000-7000-8000-000000000001';

function fakePort(refuse?: string) {
  const calls: Array<{ kind: string; fields: Record<string, unknown> }> = [];
  const estimates: EstimateFields[] = [];
  return {
    calls,
    estimates,
    port: {
      async estimate(fields: EstimateFields) {
        estimates.push(fields);
        return { ok: true as const, taskId: TASK };
      },
      async command(_taskId: string, kind: string, fields: Record<string, unknown>) {
        calls.push({ kind, fields });
        const status = kind === refuse ? 'rejected' : 'applied';
        return {
          cmdId: 'c',
          status,
          seq: 1,
          ...(status === 'rejected' ? { code: 'no-adapter', reason: 'no codex' } : {}),
        } as CommandOutcome;
      },
    },
  };
}

describe('startCoreForeignChat', () => {
  it('estimates a chat in place, sets the chosen CLI and the model, then launches', async () => {
    const f = fakePort();
    const out = await startCoreForeignChat(f.port, {
      cli: 'codex',
      cwd: 'C:/p',
      prompt: 'do it\nmore',
      title: 'Продолжение',
      model: 'gpt-5',
      preface: 'INITIATIVE',
    });
    expect(out).toEqual({ ok: true, taskId: TASK });
    expect(f.estimates[0]).toMatchObject({
      title: 'Продолжение',
      request: 'INITIATIVE\n\ndo it\nmore',
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      placement: { kind: 'in-place', grant: { project: 'C:/p', ops: ['edit'] } },
    });
    expect(f.calls.map((c) => c.kind)).toEqual(['set-cli', 'set-model', 'launch']);
    expect(f.calls[0]?.fields).toMatchObject({ adapter: 'codex', scopeId: TASK });
  });

  it('the contour checkbox route goes in as the task allowed set before the CLI is set; none — no set-route', async () => {
    const routes = [
      {
        adapter: 'goose',
        route: { kind: 'gateway' as const, id: 'gateway:acme' },
        modelPattern: '*',
      },
    ];
    const on = fakePort();
    await startCoreForeignChat(on.port, { cli: 'goose', cwd: 'C:/p', prompt: 'x', routes });
    // set-cli вне набора по умолчанию (у goose нет маршрута входа) ядро отказало бы.
    expect(on.calls.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'launch']);
    expect(on.calls[0]?.fields).toEqual({ scope: 'task', scopeId: TASK, allowedRoutes: routes });

    const off = fakePort();
    await startCoreForeignChat(off.port, { cli: 'goose', cwd: 'C:/p', prompt: 'x', routes: [] });
    expect(off.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
  });

  // s10 G7: точный шаблон контура — модель задачи; выбор человека (имя вендора) под ним ядро бы
  // отказало. Усилие через контур не уезжает.
  it('a contour route with an exact model: set-model sends that model, no effort', async () => {
    const f = fakePort();
    await startCoreForeignChat(f.port, {
      cli: 'qwen',
      cwd: 'C:/p',
      prompt: 'x',
      model: 'qwen3-max',
      effort: 'high',
      routes: [
        {
          adapter: 'qwen',
          route: { kind: 'gateway' as const, id: 'gateway:acme' },
          modelPattern: 'corp-coder',
        },
      ],
    });
    expect(f.calls.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'set-model', 'launch']);
    expect(f.calls[2]?.fields).toMatchObject({ model: 'corp-coder', effort: null });
  });

  it('a core refusal of the CLI comes back with its code and cancels the task', async () => {
    const f = fakePort('set-cli');
    const out = await startCoreForeignChat(f.port, { cli: 'qwen', cwd: 'C:/p', prompt: 'x' });
    expect(out).toEqual({ ok: false, code: 'no-adapter', message: 'set-cli: no codex' });
    expect(f.calls.map((c) => c.kind)).toEqual(['set-cli', 'cancel']);
  });
});
