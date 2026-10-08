import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatEvent } from '@agentdeck/contracts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import type { RunNotice } from '../../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';
import { createChat, patchChat } from '../store/store.ts';

/**
 * «Разрешить правки» и вопрос человеку у чата чужого CLI: служба отдаёт прогону
 * политику из шапки разговора, держит ждущие просьбы в своём хранилище и
 * отдаёт их карточке (событие + статус). CLI подменён — проверяется служба.
 */

class FakeRun implements ProviderChatRunLike {
  emit: ((event: ProviderChatRunEvent) => void) | undefined;
  options: ProviderChatRunOptions | undefined;

  start(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>(() => {});
  }

  stop(): void {}
}

const PROVIDER = { id: 'qwen', name: 'Qwen Code' } as ConfigProvider;

describe('ProviderChatService: права хода и вопрос человеку', () => {
  let dir: string;
  let run: FakeRun;
  let service: ProviderChatService;
  let events: ProviderChatEvent[];
  let notices: RunNotice[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-perm-'));
    run = new FakeRun();
    service = new ProviderChatService(() => run);
    notices = [];
    service.setNotifier((notice) => notices.push(notice));
    createChat(dir, 'qwen', { id: 'chat', workdir: dir });
    events = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (): void => {
    expect(service.send(dir, 'qwen', 'chat', { text: 'почини' }, { provider: PROVIDER }).ok).toBe(
      true,
    );
    service.subscribe('chat', { send: (event) => events.push(event), close: () => {} });
  };

  const ask = (tool = 'edit'): Promise<'allow' | 'deny'> =>
    run.options!.permission!.ask!({ cli: 'qwen', requestId: 'r1', tool, title: 'write a.txt' });

  it('разговор без переключателя — вопрос человеку, не молчаливое «да»', () => {
    send();
    expect(run.options?.permission?.allowEdits).toBe(false);
    expect(typeof run.options?.permission?.ask).toBe('function');
  });

  it('переключатель включён — прогон получает allowEdits, и флаг читается на каждом сообщении', () => {
    patchChat(dir, 'qwen', 'chat', { allowEdits: true });
    send();
    expect(run.options?.permission?.allowEdits).toBe(true);
  });

  it('просьба видна карточке: событие, статус и уведомление; «да» человека доходит до CLI', async () => {
    send();
    const decision = ask('run_shell_command');

    const pending = service.status('chat').permissions;
    expect(pending).toHaveLength(1);
    expect(pending?.[0]).toMatchObject({ tool: 'run_shell_command', title: 'write a.txt' });
    expect(events.at(-1)).toMatchObject({ type: 'permissions', permissions: pending });
    expect(notices).toEqual([
      { kind: 'permission', chatId: 'qwen:chat', projectPath: dir, toolName: 'run_shell_command' },
    ]);

    expect(service.answerPermission('chat', pending![0]!.id, 'allow')).toBe(true);
    await expect(decision).resolves.toBe('allow');
    expect(service.status('chat').permissions).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'permissions', permissions: [] });
  });

  it('«нет» человека доходит отказом; повторный ответ — просьбы уже нет', async () => {
    send();
    const decision = ask();
    const id = service.status('chat').permissions![0]!.id;
    expect(service.answerPermission('chat', id, 'deny')).toBe(true);
    await expect(decision).resolves.toBe('deny');
    expect(service.answerPermission('chat', id, 'allow')).toBe(false);
    expect(service.answerPermission('chat', 'nope', 'allow')).toBe(false);
  });

  it('«Стоп» и конец хода отвечают отказом на всё, что ждёт', async () => {
    send();
    const first = ask();
    service.stop('chat');
    await expect(first).resolves.toBe('deny');
    // Ход снят — новая просьба сразу получает отказ, человеку её не показывают.
    await expect(ask()).resolves.toBe('deny');
    expect(service.status('chat').permissions).toBeUndefined();
  });

  it('ответ пришёл — ждущая просьба отклонена, карточки больше нет', async () => {
    send();
    const decision = ask();
    run.emit!({ type: 'done', reply: 'готово', transport: 'live' });
    await expect(decision).resolves.toBe('deny');
    expect(service.status('chat').permissions).toBeUndefined();
  });
});
