import type { panelUpdateRu } from './ru.ts';

/** English texts of the panel self-update card and sidebar dot; typed against the Russian module. */
export const panelUpdateEn: typeof panelUpdateRu = {
  dotTitle: 'A new panel version is out',
  title: 'A new panel version is out',
  behind_one: '{{count}} new commit on {{upstream}}',
  behind_few: '{{count}} new commits on {{upstream}}',
  behind_many: '{{count}} new commits on {{upstream}}',
  behind_other: '{{count}} new commits on {{upstream}}',
  incomingLabel: 'What is coming',
  moreCommits_one: 'and {{count}} more commit',
  moreCommits_few: 'and {{count}} more commits',
  moreCommits_many: 'and {{count}} more commits',
  moreCommits_other: 'and {{count}} more commits',
  lockChanged:
    'New dependencies are coming — after the update the panel runs pnpm install by itself.',
  update: 'Update',
  checkNow: 'Check now',
  checking: 'Checking…',
  dirtyTitle: 'Deal with your own edits first',
  dirtyText:
    'The panel repository has uncommitted edits — the update never touches them and will not start while they are there. Commit, stash or revert them:',
  divergedTitle: 'The branch has diverged from {{upstream}}',
  divergedText:
    'Local commits here: {{ahead}}, new ones on {{upstream}}: {{behind}}. A fast-forward cannot update this: pull the changes by hand, for example git pull --rebase.',
  current: 'The latest version is installed',
  checkedAt: 'checked at {{time}}',
  fetchError: 'Could not check for updates: {{message}}',
  noUpstream: 'Branch {{branch}} does not track a server branch — nothing to compare against.',
  confirmTitle: 'Update the panel?',
  confirmText:
    'The panel fast-forwards to the new commits from {{upstream}} — your own edits and commits are left alone. The interface refreshes by itself; the server restarts once the running chat turns finish, and conversations continue where they were.',
  confirm: 'Update',
  done: 'The panel is updated to {{hash}}',
  doneWatched:
    'The new code is picked up by itself: the interface right away, the server once the running turns finish.',
  doneManual:
    'The server is not run by the dev watcher — restart the panel (pnpm dev) for the new server code to take effect.',
  installed: 'Dependencies installed.',
  installFailed:
    'The code is updated, but installing dependencies failed — run pnpm install in the panel directory. pnpm said: {{message}}',
  failed: {
    busy: 'An update is already running.',
    dirty: 'Uncommitted edits appeared in the panel repository — the update did not start.',
    current: 'There are no new commits any more — the panel is up to date.',
    'not-git': 'The panel is not run from a git clone — there is nothing to update.',
    'no-upstream': 'The branch does not track a server branch — there is nothing to update from.',
    diverged: 'The branch has diverged from the server — a fast-forward cannot update it.',
    'pull-failed': 'Git refused the fast-forward: {{message}}',
  },
  requestFailed: 'Could not update the panel: {{message}}',
};
