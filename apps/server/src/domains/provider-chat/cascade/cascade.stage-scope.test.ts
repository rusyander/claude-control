import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { createForeignStagePlanner } from './cascade.ts';
import { appendMessage, createChat } from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';

/**
 * Чужой CLI — те же правки и проверка, что у Claude (аудит g8 26.10, N2/N7/N9):
 * границы группы из плана, мера длинного списка, доказанное правками — в задании
 * следующего звена. Разговоры и шапки — настоящие файлы хранилища; подменён
 * только запуск CLI.
 */
const SCOPE = { own: ['docs/limits.mdx'], others: ['docs/agents/builder.mdx'] };

const FINDINGS = Array.from(
  { length: 16 },
  (_, index) => `🟡 F-${index + 1} scripts/check.mjs:${100 + index} — подпись`,
);

const LINK: ChatLink = {
  parentChatId: 'codex:parent',
  title: 'Доки',
  branch: 'split/docs',
  groupIndex: 0,
  createdAt: '2026-10-26T10:00:00.000Z',
  groupTask: 'Задачи группы:\n- PROJ-8',
};

describe('чужой CLI: правки и проверка знают границы группы и доказанное', () => {
  let dir: string;
  const links: Record<string, ChatLink> = {};
  const send = vi.fn().mockReturnValue({ ok: true });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pscope-'));
    send.mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Звено `cascade` кончилось ответом `text`; задание, ушедшее следующему звену. */
  function finish(cascade: ProviderChatCascade, text: string): string {
    createChat(dir, 'codex', { id: 'run', title: 'Доки', workdir: dir, cascade });
    appendMessage(dir, 'codex', 'run', { role: 'user', content: 'звено' });
    links['codex:run'] = { ...LINK, stage: cascade.stage };
    createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) =>
        id === 'codex' ? ({ id: 'codex', name: 'Codex' } as ConfigProvider) : undefined,
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => false,
      scopeOf: () => SCOPE,
    })({ providerId: 'codex', appDataDir: dir, startedAt: 0, chatId: 'run', ok: true, text });
    expect(send).toHaveBeenCalledTimes(1);
    return (send.mock.calls[0]?.[3] as { text: string }).text;
  }

  it('правки после ревью: чужие пути, запрет baseline на своих, grep при >15, раздел Proven', () => {
    const prompt = finish(
      { stage: 'review', group: 'Доки', branch: 'split/docs', workModel: 'gpt-5.3-codex' },
      ['```agentdeck:review', JSON.stringify({ findings: FINDINGS }), '```'].join('\n'),
    );

    expect(prompt).toContain('Owned by OTHER groups:');
    expect(prompt).toContain('- docs/agents/builder.mdx');
    expect(prompt).toContain('never baselined');
    expect(prompt).toContain('This list is long (16 findings)');
    expect(prompt).toContain('`Proven:`');
  });

  it('проверка после правок: доказанное — «не повторять», дифф по --stat, границы', () => {
    const prompt = finish(
      {
        stage: 'fix',
        group: 'Доки',
        branch: 'split/docs',
        workModel: 'gpt-5.3-codex',
        fixFindings: FINDINGS.slice(0, 2),
      },
      'Исправил.\n\nProven:\n- F-1 mutant scripts/check.mjs:100 killed by «check > F-1»\n',
    );

    expect(prompt).toContain('VERIFYING those fixes');
    expect(prompt).toContain('Already proven by the fixes stage');
    expect(prompt).toContain('- F-1 mutant scripts/check.mjs:100 killed by «check > F-1»');
    expect(prompt).toContain('git diff --stat');
    expect(prompt).toContain('Owned by OTHER groups:');
  });
});
