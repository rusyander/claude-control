import { describe, expect, it } from 'vitest';
import { autoNoticeList } from './autoNoticeList';

/** Отметки — в том виде, в каком их пишет сервер (`autoNoticeSummary`). */
describe('autoNoticeList', () => {
  it('разные команды — как были, через точку с запятой', () => {
    expect(autoNoticeList(['pnpm build', 'git commit -m fix'])).toBe(
      'pnpm build; git commit -m fix',
    );
  });

  it('одинаковые сводятся в «×N» на месте первого появления', () => {
    expect(autoNoticeList(['pnpm test', 'pnpm build', 'pnpm test', 'pnpm test'])).toBe(
      'pnpm test ×3; pnpm build',
    );
  });

  /** Живой прогон 20.10, карточка 28: группа 0 — ×6 и ×7 подряд, полкарточки префиксов. */
  it('вызовы MCP — под меткой сервера, инструменты со счётом', () => {
    const summaries = [
      ...Array<string>(6).fill('mcp__tracker__jira_assign_issue'),
      ...Array<string>(7).fill('mcp__tracker__jira_transition_issue'),
      'pnpm build',
      'mcp__forge__create_merge_request',
    ];
    expect(autoNoticeList(summaries)).toBe(
      'tracker: jira_assign_issue ×6, jira_transition_issue ×7; pnpm build; ' +
        'forge: create_merge_request',
    );
  });

  it('вызов MCP с файлом считается по инструменту: файлы разные, важно что прошло', () => {
    const summaries = [1, 2, 3].map((n) => `mcp__forge__upload_markdown /tmp/shot-${n}.png`);
    expect(autoNoticeList(summaries)).toBe('forge: upload_markdown ×3');
  });

  it('встроенный инструмент с путём не путается с MCP', () => {
    expect(autoNoticeList(['Edit src/a.ts', 'Edit src/a.ts', 'mcp__half'])).toBe(
      'Edit src/a.ts ×2; mcp__half',
    );
  });
});
