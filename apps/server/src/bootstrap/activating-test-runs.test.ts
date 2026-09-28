import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../domains/chat/ChatRunner.ts';
import { createGroup, upsertCase } from '../domains/project-tests/store.ts';
import { ActivatingTestRunRegistry } from './activating-test-runs.ts';

/**
 * Реестр стенда включает переходник MCP и обязан передать заявку дальше
 * ЦЕЛИКОМ: прежняя перегрузка звала `super.start(request, now)`, и материал
 * генерации («по требованию»), доступы стенда и выбор папки e2e на стенде
 * терялись, хотя в тестах голого реестра всё доходило.
 */
describe('bootstrap/activating-test-runs', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-activating-runs-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-28T00:00:00.000Z');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('включает переходник и передаёт материал и доступы в задание и окружение агента', async () => {
    const seen: { prompt: string; env: Record<string, string> } = { prompt: '', env: {} };
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (options) => {
      seen.prompt = options.prompt;
      seen.env = (options as { env?: Record<string, string> }).env ?? {};
    });
    const activated: string[] = [];
    const registry = new ActivatingTestRunRegistry((path) => activated.push(path));

    registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui', source: 'requirement' },
      '2026-09-28T00:00:00.000Z',
      {
        source: 'requirement',
        requirement: { key: 'QA-42', url: 'https://tracker.example.com/QA-42', title: 'Вход' },
      },
      () => ({ values: { STAND_TOKEN: 'tok-123' }, missing: [] }),
    );
    await vi.waitFor(() => expect(seen.prompt).not.toBe(''));
    registry.stop(root);

    expect(activated).toEqual([root]);
    expect(seen.prompt).toContain('REQUIREMENT QA-42');
    expect(seen.env.STAND_TOKEN).toBe('tok-123');
  });
});
