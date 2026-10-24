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
import { createChat, patchChat, readChat } from '../store/store.ts';
import { decidePermission } from '../live/permission.ts';

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

  it('судья команд (P-01..P-05): получает разговор и команду; отказ с причиной уходит модели, карточки нет', async () => {
    const calls: unknown[] = [];
    const steered: string[] = [];
    (run as FakeRun & { steer: (text: string) => Promise<boolean> }).steer = async (text) => {
      steered.push(text);
      return true;
    };
    service.setShellJudge(async (call) => {
      calls.push(call);
      return call.shell.command.startsWith('git branch -D')
        ? { behavior: 'deny', message: 'D-1 ждёт человека' }
        : { behavior: 'allow' };
    });
    patchChat(dir, 'qwen', 'chat', { allowEdits: true });
    send();
    const judge = run.options!.permission!.judge!;
    expect(typeof run.options?.permission?.onRefusal).toBe('function');
    const shellAsk = (command: string) =>
      decidePermission(run.options!.permission, {
        cli: 'qwen',
        requestId: 'r1',
        tool: 'execute',
        shell: { command, shell: 'bash' },
      });
    await expect(shellAsk('git branch -D old')).resolves.toBe('deny');
    await expect(shellAsk('pnpm build')).resolves.toBe('allow');
    expect(calls[0]).toEqual({
      providerId: 'qwen',
      chatId: 'chat',
      workdir: dir,
      allowEdits: true,
      title: 'Новый разговор',
      shell: { command: 'git branch -D old', shell: 'bash' },
    });
    expect(steered).toEqual(['[agentdeck] D-1 ждёт человека']);
    expect(service.status('chat').permissions).toBeUndefined();
    expect(judge).toBeDefined();
  });

  /**
   * Отказ судьи — ДО ответа CLI (Codex кладёт вставку в следующий же запрос
   * модели, только если она пришла раньше отказа; иначе модель видит лишь
   * «rejected by user»), заметкой человеку в переписке; pid CLI доходит до судьи.
   */
  it('отказ судьи: вставка в ход дождана до ответа, заметка в переписке, pid CLI у судьи', async () => {
    const order: string[] = [];
    const calls: unknown[] = [];
    let release: () => void = () => undefined;
    (run as FakeRun & { steer: (text: string) => Promise<boolean> }).steer = (text) =>
      new Promise<boolean>((done) => {
        order.push(`steer: ${text}`);
        release = () => {
          order.push('steer delivered');
          done(true);
        };
      });
    service.setShellJudge(async (call) => {
      calls.push(call);
      return { behavior: 'deny', message: 'D-1 ждёт человека' };
    });
    patchChat(dir, 'qwen', 'chat', { allowEdits: true });
    send();
    const decision = decidePermission(run.options!.permission, {
      cli: 'qwen',
      requestId: 'r7',
      tool: 'execute',
      pid: 4242,
      shell: { command: 'git branch -D x', shell: 'unknown' },
    }).then((answer) => (order.push(`answer: ${answer}`), answer));
    await new Promise((done) => setTimeout(done, 20));
    // Вставка ещё в пути — CLI ответа не получил.
    expect(order).toEqual(['steer: [agentdeck] D-1 ждёт человека']);
    release();
    await expect(decision).resolves.toBe('deny');
    expect(order).toEqual([
      'steer: [agentdeck] D-1 ждёт человека',
      'steer delivered',
      'answer: deny',
    ]);
    expect(calls[0]).toMatchObject({ pid: 4242, shell: { command: 'git branch -D x' } });
    const notice = readChat(dir, 'qwen', 'chat')?.messages.at(-1);
    expect(notice?.role).toBe('notice');
    expect(notice?.content).toContain('git branch -D x');
    expect(notice?.content).toContain('D-1 ждёт человека');
  });

  it('судья ответил «человеку» — карточка, как без судьи; судья упал — тоже карточка, не «да»', async () => {
    service.setShellJudge(async (call) => {
      if (call.shell.command === 'boom') throw new Error('сломан');
      return { behavior: 'human' };
    });
    patchChat(dir, 'qwen', 'chat', { allowEdits: true });
    send();
    for (const command of ['git merge feat/x', 'boom']) {
      const decision = decidePermission(run.options!.permission, {
        cli: 'qwen',
        requestId: `r-${command}`,
        tool: 'execute',
        shell: { command, shell: 'bash' },
      });
      await new Promise((done) => setTimeout(done, 20));
      const pending = service.status('chat').permissions;
      expect(pending, command).toHaveLength(1);
      service.answerPermission('chat', pending![0]!.id, 'deny');
      await expect(decision).resolves.toBe('deny');
    }
  });

  it('ответ пришёл — ждущая просьба отклонена, карточки больше нет', async () => {
    send();
    const decision = ask();
    run.emit!({ type: 'done', reply: 'готово', transport: 'live' });
    await expect(decision).resolves.toBe('deny');
    expect(service.status('chat').permissions).toBeUndefined();
  });
});
