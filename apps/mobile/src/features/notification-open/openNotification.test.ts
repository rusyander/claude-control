import { describe, expect, it, vi } from 'vitest';
import { openNotification, type NotificationOpenDeps } from './openNotification';

/**
 * Переход из уведомления (`_layout.tsx`): push о вопросе ядра открывает экран этой задачи с этим
 * вопросом на панели той машины, что его прислала; push разговора — как раньше.
 */

const TASK = '019a0000-0000-7000-8000-000000000001';
const ASK = '019a0000-0000-7000-8000-0000000000a1';

function deps(panel?: object) {
  const calls: string[] = [];
  const value: NotificationOpenDeps & { calls: string[] } = {
    calls,
    panelForMachine: vi.fn(() => panel),
    activatePanel: vi.fn(async () => void calls.push('activate')),
    push: vi.fn((href) => void calls.push(`push ${JSON.stringify(href)}`)),
    openChat: vi.fn((chatId: string) => void calls.push(`chat ${chatId}`)),
  };
  return value;
}

describe('open from notification', () => {
  it('core-ask push → that panel first, then the core task screen with the ask', async () => {
    const panel = { id: 'p2' };
    const d = deps(panel);
    await openNotification({ kind: 'core-ask', taskId: TASK, askId: ASK, machineId: 'm-2' }, d);
    expect(d.panelForMachine).toHaveBeenCalledWith('m-2');
    expect(d.calls).toEqual([
      'activate',
      `push ${JSON.stringify({ pathname: '/core-task', params: { id: TASK, ask: ASK } })}`,
    ]);
    expect(d.openChat).not.toHaveBeenCalled();
  });

  it('chat pushes keep their routes; an unknown push opens nothing', async () => {
    const claude = deps();
    await openNotification({ chatId: 'c1', projectPath: '/p' }, claude);
    expect(claude.calls).toEqual(['chat c1', 'push "/chat"']);
    const foreign = deps();
    await openNotification({ chatId: 'codex:abc' }, foreign);
    expect(foreign.calls).toEqual([
      `push ${JSON.stringify({ pathname: '/foreign-chat', params: { provider: 'codex', id: 'abc' } })}`,
    ]);
    const none = deps();
    await openNotification({ kind: 'done' }, none);
    expect(none.calls).toEqual([]);
  });
});
