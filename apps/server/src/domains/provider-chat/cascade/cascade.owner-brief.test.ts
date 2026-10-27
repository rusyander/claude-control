import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownerRequestBlock } from '@agentdeck/contracts/quality-floor';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { OWNER_BRIEF } from '../../chat/owner-brief/owner-brief.ts';
import { createForeignStagePlanner } from './cascade.ts';
import { appendMessage, createChat } from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';

/**
 * Чужой CLI — та же запись, что у Claude (живая группа 26.10): старт звена кладёт
 * слова владельца и сданные строки файлом в копию, путь к нему — в правилах
 * группы. Разговоры и шапки — настоящие файлы хранилища; подменён только запуск CLI.
 */
const OWNER = 'Доска PROJ: возьми фронтовые задачи, глубокое ревью, MR без мержа.';
const GROUP_TASK = `${ownerRequestBlock([OWNER])}\n\nЗадачи группы:\n- PROJ-1`;

const FIX: ProviderChatCascade = {
  stage: 'fix',
  group: 'Доки',
  branch: 'split/docs',
  kind: 'mechanical',
  lowered: true,
  workModel: 'gpt-5.3-codex-spark',
  workEffort: 'medium',
};

const LINK: ChatLink = {
  parentChatId: 'codex:parent',
  title: 'Доки',
  branch: 'split/docs',
  groupIndex: 0,
  createdAt: '2026-10-26T10:00:00.000Z',
  stage: 'fix',
  groupTask: GROUP_TASK,
  sieveRows: [{ id: 'owner-1', status: 'pass', evidence: 'npx vitest → 78 passed' }],
};

describe('чужой CLI: старт звена пишет файл слов владельца', () => {
  let dir: string;
  const links: Record<string, ChatLink> = {};
  const send = vi.fn().mockReturnValue({ ok: true });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-powner-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('доставка после правок: дословная просьба и строки owner-N обоих звеньев', () => {
    createChat(dir, 'codex', { id: 'fix', title: 'Доки', workdir: dir, cascade: FIX });
    appendMessage(dir, 'codex', 'fix', { role: 'user', content: 'Поправь по замечаниям' });
    links['codex:fix'] = LINK;
    const answer =
      'Поправил.\n\n```agentdeck:sieves\n' +
      '{"sieves":[{"id":"owner-2","status":"n/a","evidence":"other group: API"}]}\n```';

    createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) =>
        id === 'codex' ? ({ id: 'codex', name: 'Codex' } as ConfigProvider) : undefined,
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => true,
    })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'fix',
      ok: true,
      text: answer,
    });

    // Доставка действительно стартовала — файл пишет её старт.
    expect(send).toHaveBeenCalledTimes(1);
    const text = readFileSync(join(dir, OWNER_BRIEF), 'utf8');
    expect(text).toContain(OWNER);
    expect(text).toContain('- owner-1 pass — npx vitest → 78 passed');
    expect(text).toContain('- owner-2 n/a — other group: API');
    expect(text).not.toContain('Задачи группы');
  });
});
