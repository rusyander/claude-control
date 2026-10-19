import { describe, it, expect } from 'vitest';
import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  resolveSplitDefaults,
  type GroupRequestId,
} from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from './group-permissions.ts';

/** Строки по умолчанию для группы: запись наружу и снос — человеку, остальное само. */
function group(): GroupAutoApprove {
  const rows = Object.fromEntries(GROUP_REQUEST_IDS.map((id) => [id, 'auto'])) as Record<
    GroupRequestId,
    'auto'
  >;
  return {
    rows: { ...rows, externalWrite: 'human', externalDestroy: 'human' },
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
  };
}

const decide = (toolName: string, allowedTools?: ReadonlySet<string>): string =>
  groupDecision(group(), {
    toolName,
    input: {},
    guardedPatterns: [],
    ...(allowedTools ? { allowedTools } : {}),
  });

describe('groupDecision — MCP-сервер, отданный брокеру правилом ask', () => {
  /**
   * Журнал 19.10 19:41: группа под `ask` на весь сервер GitLab (L6.2) вставала
   * карточкой на каждом `mr_discussions` — у имени нет глагола чтения, а свой
   * список `allow` CLI к серверу под `ask` уже не применяет.
   */
  it('чтение без глагола в имени (`mr_discussions`) проходит само', () => {
    expect(decide('mcp__gitlab-work__mr_discussions')).toBe('auto');
    expect(decide('mcp__atlassian-work__jira_batch_get_changelogs')).toBe('auto');
    expect(decide('mcp__gitlab-work__wait_for_pipeline')).toBe('auto');
  });

  it('инструмент, разрешённый человеком по имени, не спрашивает', () => {
    const allowed = new Set(['mcp__gitlab-work__frobnicate_things']);
    expect(decide('mcp__gitlab-work__frobnicate_things')).toBe('human');
    expect(decide('mcp__gitlab-work__frobnicate_things', allowed)).toBe('auto');
  });

  it('запись без разрешения по имени и снос даже с ним — человеку', () => {
    const allowed = new Set(['mcp__gitlab-work__delete_branch']);
    expect(decide('mcp__gitlab-work__create_merge_request_note')).toBe('human');
    expect(decide('mcp__gitlab-work__delete_branch', allowed)).toBe('human');
  });
});

describe('groupDecision — строки по умолчанию, ничего не сохранено', () => {
  /**
   * Снимки владельца 19.10: ответ в тред MR, правка своей заметки, вложение в
   * задачу и правка комментария вставали карточкой «Агент просит разрешение».
   * Запись наружу по умолчанию идёт сама с отметкой; снос и слияние — человеку.
   */
  const fresh = (toolName: string): string =>
    groupDecision(
      {
        rows: resolveGroupPermissions(resolveSplitDefaults(undefined).permissions, undefined),
        allowEdits: true,
        parentChatId: 'p',
        groupIndex: 1,
      },
      { toolName, input: { attachments: ['C:/shot.png'] }, guardedPatterns: [] },
    );

  it.each([
    'mcp__gitlab-work__create_merge_request_discussion_note',
    'mcp__gitlab-work__update_merge_request_discussion_note',
    'mcp__gitlab-work__create_merge_request_note',
    'mcp__atlassian-work__jira_update_issue',
    'mcp__atlassian-work__jira_edit_comment',
    'mcp__atlassian-work__jira_add_comment',
  ])('%s — с отметкой, без карточки', (tool) => {
    expect(fresh(tool)).toBe('notify');
  });

  it.each([
    'mcp__gitlab-work__merge_merge_request',
    'mcp__gitlab-work__accept_merge_request',
    'mcp__atlassian-work__jira_delete_issue',
  ])('%s — человеку', (tool) => {
    expect(fresh(tool)).toBe('human');
  });
});
