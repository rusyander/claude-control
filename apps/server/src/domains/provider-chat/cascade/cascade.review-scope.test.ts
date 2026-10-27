import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REVIEW_BLOCK_LANG } from '@agentdeck/contracts/model-cascade';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { readHeadSha } from '../../project-git/read.ts';
import { createForeignStagePlanner } from './cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';

/**
 * Ревью группы чужого CLI — только сделанное ЭТОЙ группой (владелец 26.10, замечание 4),
 * как у Claude: охват от коммита начала (`ChatLink.startSha`), найденное вне охвата —
 * «было до группы» мимо правок, пустой охват — без ревью, с причиной в ленте.
 * Настоящие git-репозиторий, хранилище разговоров и `readReviewDelta`; подменён только
 * запуск CLI.
 */

const WORK: ProviderChatCascade = {
  stage: 'work',
  group: 'Конфликт',
  branch: 'feature/mr',
  workModel: 'gpt-5.3-codex',
  workEffort: 'high',
};
const REVIEW: ProviderChatCascade = { ...WORK, stage: 'review' };

describe('чужой CLI: охват ревью от коммита начала группы', () => {
  let dir: string;
  let root: string;
  let work: string;
  let start: string;
  let links: Record<string, ChatLink>;
  let send: ReturnType<typeof vi.fn>;
  const provider = { id: 'codex', name: 'Codex' } as ConfigProvider;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const commit = (file: string, text: string, message: string): void => {
    writeFileSync(join(work, file), text);
    git(work, 'add', file);
    git(work, 'commit', '-q', '-m', message);
  };
  const mainMoves = (file: string, text: string): void => {
    const other = join(root, 'other');
    git(root, 'clone', '-q', join(root, 'remote.git'), other);
    writeFileSync(join(other, file), text);
    git(other, 'add', file);
    git(other, 'commit', '-q', '-m', `main: ${file}`);
    git(other, 'push', '-q', 'origin', 'main');
    rmSync(other, { recursive: true, force: true });
    git(work, 'fetch', '-q', 'origin');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pscope-'));
    root = mkdtempSync(join(tmpdir(), 'cc-pscope-git-'));
    work = join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    git(root, 'clone', '-q', join(root, 'remote.git'), work);
    commit('shared.txt', 'base\n', 'base');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'remote', 'set-head', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'feature/mr');
    commit('feature.txt', 'feature\n', 'mr: feature');
    git(work, 'push', '-q', '-u', 'origin', 'feature/mr');
    start = readHeadSha(work) ?? '';
    links = {};
    send = vi.fn().mockReturnValue({ ok: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const planner = () =>
    createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => true,
    });

  function chat(id: string, cascade: ProviderChatCascade, extra: Partial<ChatLink> = {}): void {
    createChat(dir, 'codex', { id, title: 'Конфликт', workdir: work, cascade });
    appendMessage(dir, 'codex', id, { role: 'user', content: 'Разреши конфликт с main' });
    links[`codex:${id}`] = {
      parentChatId: 'codex:parent',
      title: 'Конфликт',
      branch: 'feature/mr',
      groupIndex: 0,
      createdAt: '2026-10-26T10:00:00.000Z',
      stage: cascade.stage,
      startSha: start,
      ...extra,
    };
  }
  const finish = (chatId: string, text: string) => ({
    providerId: 'codex',
    appDataDir: dir,
    startedAt: 0,
    chatId,
    ok: true,
    text,
  });
  const started = (stage: string): { id: string; prompt: string }[] =>
    send.mock.calls
      .filter((call) => readChatCascade(dir, 'codex', call[2] as string)?.stage === stage)
      .map((call) => ({ id: call[2] as string, prompt: (call[3] as { text: string }).text }));

  it('работа с коммитом новой группы — ревью только её коммитов, «было до группы» отдельно', () => {
    commit('fix.txt', 'fix\n', 'group: fix');
    chat('work', WORK);
    planner()(finish('work', 'Сделал.'));
    const [review] = started('review');
    expect(review?.prompt).toContain(`started at commit ${start.slice(0, 12)}`);
    expect(review?.prompt).toContain('group: fix');
    expect(review?.prompt).not.toContain('mr: feature');
    expect(review?.prompt).not.toContain('once and in full');
    expect(review?.prompt).toContain('"preExisting"');
    // Коммит начала едет связью звена дальше.
    expect(links[`codex:${review?.id}`]?.startSha).toBe(start);
  });

  it('только чистое слияние основной — ревью нет, доставка с причиной, строка в ленте', () => {
    mainMoves('other.txt', 'other\n');
    git(work, 'merge', '-q', '--no-edit', 'origin/main');
    chat('work', WORK);
    planner()(finish('work', 'Слил main.'));
    expect(started('review')).toEqual([]);
    const [deliver] = started('deliver');
    expect(deliver?.prompt).toContain('the panel skipped its review');
    expect(deliver?.prompt).toContain(start.slice(0, 12));
    const notices = readChat(dir, 'codex', 'work')
      ?.messages.filter((message) => message.role === 'notice')
      .map((message) => message.content);
    expect(notices?.join('\n')).toContain(`Ревью не заводилось: с коммита ${start.slice(0, 12)}`);
  });

  it('начало группы неизвестно (связь без startSha, P-37) — ревью всей ветки, без охвата и без пропуска', () => {
    // То же чистое слияние основной, что выше пропускало ревью: без коммита начала охвата нет,
    // и ревью заводится как раньше — целиком, без строки «Ревью не заводилось».
    mainMoves('other.txt', 'other\n');
    git(work, 'merge', '-q', '--no-edit', 'origin/main');
    chat('work', WORK);
    delete links['codex:work']?.startSha;
    planner()(finish('work', 'Слил main.'));
    const [review] = started('review');
    expect(review?.prompt).toContain('once and in full');
    expect(review?.prompt).not.toContain('started at commit');
    expect(started('deliver')).toEqual([]);
    expect(links[`codex:${review?.id}`]?.startSha).toBeUndefined();
    const notices = readChat(dir, 'codex', 'work')
      ?.messages.filter((message) => message.role === 'notice')
      .map((message) => message.content);
    expect(notices?.join('\n') ?? '').not.toContain('Ревью не заводилось');
  });

  it('найденное вне охвата правкам не уходит, связью доезжает до доставки в MR', () => {
    chat('review', REVIEW);
    const block = {
      findings: ['🟡 1. **забыт await** a.ts:1-2'],
      preExisting: ['🟡 1. **давний таймаут** old.ts:5-6'],
    };
    planner()(finish('review', `\`\`\`${REVIEW_BLOCK_LANG}\n${JSON.stringify(block)}\n\`\`\``));
    const [fix] = started('fix');
    expect(fix?.prompt).toContain('забыт await');
    expect(fix?.prompt).not.toContain('давний таймаут');
    expect(links[`codex:${fix?.id}`]?.preExisting).toEqual(block.preExisting);

    // Чистое ревью с одним «было до группы» — доставка называет его в MR.
    send.mockClear();
    chat('clean', REVIEW);
    planner()(
      finish(
        'clean',
        `\`\`\`${REVIEW_BLOCK_LANG}\n${JSON.stringify({ findings: [], preExisting: block.preExisting })}\n\`\`\``,
      ),
    );
    const [deliver] = started('deliver');
    expect(deliver?.prompt).toContain('pre-existing, NOT fixed by this group');
    expect(deliver?.prompt).toContain('1. 🟡 1. **давний таймаут** old.ts:5-6');
  });
});
