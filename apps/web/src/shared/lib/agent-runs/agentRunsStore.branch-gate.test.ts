import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Ворота первой правки у родителя, чья работа отдана группам (Д15): кому отдана
 * и от какой ветки MR встанет копия, — сервер шлёт это в событии, и карточка
 * без этих полей снова выглядела бы обычной «где работаем?».
 */

/** Открытый поток, который живёт, пока запрос не отменят. */
function liveResponse(init: RequestInit | undefined, frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const encoder = new TextEncoder();
      for (const frame of frames) ctrl.enqueue(encoder.encode(`${frame}\n\n`));
      init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason), {
        once: true,
      });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('ворота ветки: работа отдана группам (Д15)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('группы и ветка MR из события доезжают до карточки', async () => {
    const gate = {
      kind: 'branchGate',
      toolName: 'Edit',
      input: { file_path: 'a.ts' },
      toolUseId: 'tool-1',
      cwd: '/repo',
      branch: 'agent/x',
      children: [{ number: 1, title: 'Шапка', branch: 'mr-feature', status: 'started' }],
      base: 'origin/mr-feature',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        liveResponse(init, [`data: ${JSON.stringify(gate)}`]),
      ),
    );

    void agentRuns.start({ chatId: 'new-gate', prompt: 'привет' });
    await settle();

    expect(getRun('new-gate').branchGates).toEqual([
      {
        toolName: 'Edit',
        input: { file_path: 'a.ts' },
        toolUseId: 'tool-1',
        cwd: '/repo',
        branch: 'agent/x',
        children: gate.children,
        base: 'origin/mr-feature',
      },
    ]);

    agentRuns.stop('new-gate');
    agentRuns.clear('new-gate');
  });
});
