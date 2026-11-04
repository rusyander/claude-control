import { describe, expect, it } from 'vitest';
import {
  forgeMcpServers,
  forgeMcpVerdict,
  forgeServerEvidence,
  forgeToolClass,
  READ_VERBS,
} from './mcp-tools.ts';

/**
 * Правило `forge-mcp-read-only` (P82) по имени: настоящие имена инструментов серверов GitLab
 * (`@zereight/mcp-gitlab`) и GitHub (`github-mcp-server`) — чтение проходит, запись и незнакомое
 * имя — нет. Дорога сеанса проверена отдельно (`forge-mcp.live.integration.test.ts`).
 */

describe('forge-mcp-read-only: tool class by name', () => {
  it.each([
    'get_merge_request',
    'list_merge_requests',
    'get_merge_request_diffs',
    'get_issue_comment',
    'get_commit',
    'search_repositories',
    'get_file_contents',
    'list_pipelines',
    'get_me',
    'issue_read',
    'pull_request_read',
    'download_attachment',
    'getMergeRequest',
  ])('%s is a read', (tool) => {
    expect(forgeToolClass(tool)).toBe('read');
  });

  it.each([
    'create_merge_request',
    'update_merge_request',
    'merge_merge_request',
    'create_note',
    'create_merge_request_thread',
    'push_files',
    'create_or_update_file',
    'delete_branch',
    'fork_repository',
    'add_issue_comment',
    'issue_write',
    'pull_request_review_write',
    'mark_all_notifications_read',
    'execute_graphql',
    'approve_merge_request',
    'createMergeRequest',
  ])('%s is a write', (tool) => {
    expect(forgeToolClass(tool)).toBe('write');
  });

  it.each(['gitlab_api_request', 'discover_tools', 'help', 'project_info', ''])(
    '%s is unknown (not proven read-only)',
    (tool) => {
      expect(forgeToolClass(tool)).toBe('unknown');
    },
  );

  it('the read vocabulary never overlaps a write verb', () => {
    for (const verb of READ_VERBS) expect(forgeToolClass(`${verb}_x`)).toBe('read');
  });
});

describe('forge-mcp-read-only: which human servers are forge servers', () => {
  const stdio = (command: string, args: string[] = [], env?: Record<string, string>) => ({
    command,
    args,
    ...(env ? { env } : {}),
  });

  it('by name, launch package, env NAME, url word and configured host; a plain server is not one', () => {
    expect(forgeServerEvidence('gitlab-acme', stdio('node'), [])).toBe('name has «gitlab»');
    expect(forgeServerEvidence('code', stdio('npx', ['-y', '@zereight/mcp-gitlab']), [])).toBe(
      'launch has «gitlab»',
    );
    expect(
      forgeServerEvidence('code', stdio('server', [], { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' }), []),
    ).toBe('env GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(
      forgeServerEvidence(
        'remote',
        { url: 'https://api.githubcopilot.com/mcp/', transport: 'http' },
        [],
      ),
    ).toBe('url has «github»');
    expect(
      forgeServerEvidence(
        'company',
        stdio('srv', [], { API_URL: 'https://git.corp.example/api' }),
        ['git.corp.example'],
      ),
    ).toBe('env API_URL names the configured forge git.corp.example');
    expect(
      forgeServerEvidence('company', { url: 'https://git.corp.example/mcp', transport: 'sse' }, [
        'git.corp.example',
      ]),
    ).toBe('url is the configured forge git.corp.example');
    expect(forgeServerEvidence('files', stdio('npx', ['@mcp/fs'], { ROOT: '/x' }), [])).toBeNull();
  });

  it('forgeMcpServers keeps only the forge ones, with the evidence', () => {
    expect(forgeMcpServers({ 'gitlab-x': stdio('node'), files: stdio('node') }, [])).toEqual([
      { id: 'gitlab-x', why: 'name has «gitlab»' },
    ]);
  });
});

describe('forge-mcp-read-only: verdict on a full tool name', () => {
  it('only tools of a listed server are judged; the longest server name wins; CLI name mangling', () => {
    expect(forgeMcpVerdict('mcp__files__create_file', ['gitlab'])).toBeNull();
    expect(forgeMcpVerdict('mcp__gitlab__create_note', ['gitlab'])).toEqual({
      server: 'gitlab',
      tool: 'create_note',
      cls: 'write',
    });
    expect(forgeMcpVerdict('mcp__gitlab__get_issue', ['gitlab'])?.cls).toBe('read');
    expect(forgeMcpVerdict('mcp__gitlab__x__get_y', ['gitlab', 'gitlab__x'])?.server).toBe(
      'gitlab__x',
    );
    expect(forgeMcpVerdict('mcp__git_lab__push_files', ['git.lab'])?.cls).toBe('write');
  });
});
