import { describe, expect, it } from 'vitest';
import { githubActivity } from './github-map.ts';
import { gitlabActivity } from './gitlab-map.ts';

/**
 * Номер MR у заметки ленты (05:77): у GitLab номера issue и MR — разные пространства, у заметки
 * к issue №12 `noteable_iid` тоже 12, и опрос не должен принять её за заметку к MR !12. У GitHub
 * номер общий, но комментарий к обычному issue (без `pull_request`) — не заметка к PR.
 */

const AT = '2026-10-31T10:00:00.000Z';

const gitlabNote = (noteableType: string) => ({
  id: 501,
  action_name: 'commented on',
  author: { username: 'reviewer' },
  created_at: AT,
  target_iid: 12,
  target_id: 9001,
  target_type: 'Note',
  note: { id: 9001, noteable_type: noteableType, noteable_iid: 12 },
});

const githubComment = (issue: Record<string, unknown>) => ({
  id: '601',
  type: 'IssueCommentEvent',
  actor: { login: 'reviewer' },
  created_at: AT,
  payload: { action: 'created', issue, comment: { id: 9002 } },
});

describe('a note on an issue is not a note on the MR with the same number (F4)', () => {
  it('GitLab: a note on Issue #12 carries no mrIid; a note on MR !12 carries 12', () => {
    expect(gitlabActivity(gitlabNote('Issue'))).toMatchObject({ type: 'note' });
    expect(gitlabActivity(gitlabNote('Issue'))).not.toHaveProperty('mrIid');
    expect(gitlabActivity(gitlabNote('MergeRequest'))).toMatchObject({
      type: 'note',
      mrIid: 12,
      objectId: '9001',
    });
  });

  it('GitLab: a commit or snippet note carries no mrIid either', () => {
    expect(gitlabActivity(gitlabNote('Commit'))).not.toHaveProperty('mrIid');
    expect(gitlabActivity(gitlabNote('Snippet'))).not.toHaveProperty('mrIid');
  });

  it('GitHub: a comment on a plain issue carries no mrIid; on a pull request it does', () => {
    expect(githubActivity(githubComment({ number: 12 }))).not.toHaveProperty('mrIid');
    expect(githubActivity(githubComment({ number: 12, pull_request: { url: 'x' } }))).toMatchObject(
      { type: 'note', mrIid: 12, objectId: '9002' },
    );
  });
});
