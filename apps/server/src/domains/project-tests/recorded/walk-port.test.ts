import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { describe, expect, it } from 'vitest';
import type { CoreChatPort } from '../../chat/core-run/core-run.types.ts';
import { createCoreWalkPort } from './walk-port.ts';

/**
 * Порт прохода к ядру: одна оценка `browser-walk` с запуском политикой `auto`, без команды
 * `launch` следом — на живом ядре она приходила в `estimating` и падала `state-conflict`
 * (живое доказательство — `routes/project-tests/recorded-routes/recorded-walk-core.live.integration.test.ts`).
 */
function fakePort(reply: Awaited<ReturnType<CoreChatPort['estimate']>>) {
  const estimates: EstimateFields[] = [];
  const commands: string[] = [];
  const port = {
    estimate: async (fields: EstimateFields) => {
      estimates.push(fields);
      return reply;
    },
    command: async (_taskId: string, kind: string) => {
      commands.push(kind);
      return { cmdId: '', status: 'rejected', code: 'state-conflict', seq: 0 };
    },
  } as unknown as CoreChatPort;
  return { port, estimates, commands };
}

describe('core walk port', () => {
  it('opens one browser-walk estimate that the core launches itself, and sends no launch command', async () => {
    const { port, estimates, commands } = fakePort({ ok: true, taskId: 'task-1' });
    const opened = await createCoreWalkPort(port).open({
      root: 'C:/work/demo',
      title: 'Проход по стенду: вход',
      text: 'Walk the stand',
    });
    expect(opened).toEqual({ taskId: 'task-1' });
    expect(estimates).toHaveLength(1);
    expect(estimates[0]).toMatchObject({
      request: 'Walk the stand',
      repos: [{ path: 'C:/work/demo', baseRef: null }],
      scenario: { preset: 'browser-walk' },
      launchPolicy: 'auto',
      ciWait: false,
    });
    expect(commands).toEqual([]);
  });

  it('a core refusal of the estimate surfaces with its code', async () => {
    const { port, commands } = fakePort({
      ok: false,
      code: 'estimate-refused',
      message: 'cli: claude not found',
    });
    await expect(
      createCoreWalkPort(port).open({ root: 'C:/work/demo', title: 't', text: 'x' }),
    ).rejects.toThrow('estimate-refused: cli: claude not found');
    expect(commands).toEqual([]);
  });
});
