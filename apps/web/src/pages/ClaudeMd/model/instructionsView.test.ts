import { describe, it, expect } from 'vitest';
import type { InstructionsFileInfo } from '@claude-control/contracts';
import { instructionsView } from './instructionsView';

/** Собрать ответ раздела инструкций с нужными полями (остальное — разумные значения). */
function info(overrides: Partial<InstructionsFileInfo>): InstructionsFileInfo {
  return {
    content: '',
    exists: false,
    fileName: 'CLAUDE.md',
    filePath: '/home/u/.claude/CLAUDE.md',
    cliDetected: true,
    providerId: 'claude',
    providerName: 'Claude Code',
    ...overrides,
  };
}

describe('instructionsView: адаптация раздела под провайдера', () => {
  it('claude: те же ключи, что и раньше, без подсказки о CLI (регресс-ноль)', () => {
    const view = instructionsView(info({ providerId: 'claude' }));
    expect(view.isClaude).toBe(true);
    expect(view.title).toEqual({ key: 'claudeMd.title' });
    expect(view.subtitle).toEqual({ key: 'claudeMd.subtitle' });
    expect(view.explain).toEqual({ key: 'claudeMd.explain' });
    expect(view.cliHint).toBeUndefined();
  });

  it('codex: заголовок содержит имя файла и провайдера (AGENTS.md / Codex)', () => {
    const view = instructionsView(
      info({
        providerId: 'codex',
        providerName: 'Codex (OpenAI)',
        fileName: 'AGENTS.md',
        filePath: '/home/u/.codex/AGENTS.md',
        cliDetected: true,
      }),
    );
    expect(view.isClaude).toBe(false);
    expect(view.title.key).toBe('claudeMd.titleFor');
    expect(view.title.params).toEqual({ fileName: 'AGENTS.md', provider: 'Codex (OpenAI)' });
    expect(view.subtitle.params).toEqual({ provider: 'Codex (OpenAI)' });
    expect(view.explain.params).toEqual({ path: '/home/u/.codex/AGENTS.md' });
    // CLI обнаружен → подсказки нет.
    expect(view.cliHint).toBeUndefined();
  });

  it('gemini: имя файла GEMINI.md в заголовке', () => {
    const view = instructionsView(
      info({ providerId: 'gemini', providerName: 'Gemini CLI', fileName: 'GEMINI.md' }),
    );
    expect(view.title.params).toMatchObject({ fileName: 'GEMINI.md', provider: 'Gemini CLI' });
  });

  it('CLI не обнаружен → неалармирующая подсказка с провайдером и путём', () => {
    const view = instructionsView(
      info({
        providerId: 'codex',
        providerName: 'Codex (OpenAI)',
        fileName: 'AGENTS.md',
        filePath: '/home/u/.codex/AGENTS.md',
        cliDetected: false,
      }),
    );
    expect(view.cliHint).toEqual({
      key: 'claudeMd.cliMissing',
      params: { provider: 'Codex (OpenAI)', path: '/home/u/.codex/AGENTS.md' },
    });
  });
});
