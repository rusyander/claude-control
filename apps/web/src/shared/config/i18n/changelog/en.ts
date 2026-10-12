import type { changelogRu } from './ru.ts';

/** English texts of the “What’s new” tab; typed against the Russian module. */
export const changelogEn: typeof changelogRu = {
  listLabel: 'Releases',
  source: {
    label: 'Source',
    all: 'All',
    curated: 'Described',
    git: 'From git',
  },
  kindsLabel: 'Kind of change',
  kinds: {
    added: 'Added',
    improved: 'Improved',
    fixed: 'Fixed',
    changed: 'Changed',
    removed: 'Removed',
    docs: 'Docs',
    internal: 'Internal',
  },
  areasLabel: 'What was touched',
  areas: {
    web: 'Web',
    server: 'Server',
    mobile: 'Phone',
    contracts: 'Contracts',
    tools: 'Tools',
    tests: 'Tests',
    docs: 'Docs',
    other: 'Other',
  },
  badge: {
    pending: 'Unpublished',
    git: 'From git',
    tree: 'Working tree',
  },
  tree: {
    title: 'Uncommitted changes',
    summary:
      'Every change in the working tree against the last commit, not split by task. What of it is already described shows in the “Unpublished” cards above.',
  },
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  how: 'How:',
  image: {
    before: 'Before',
    after: 'After',
    shot: 'Screenshot',
    open: 'Open screenshot: {{name}}',
  },
  commits: 'Commits ({{count}})',
  copyHash: 'Copy hash {{hash}}',
  filesTotal: 'Files: {{files}}',
  linesAdded: 'lines added: {{count}}',
  linesRemoved: 'lines removed: {{count}}',
  showMore: 'Show {{count}} more',
  empty: {
    title: 'Nothing here yet',
    text: 'The repository has neither release descriptions nor commits.',
    filtered: 'Nothing matches the selected filters',
    reset: 'Reset filters',
  },
  gitMissing: 'Git history is unavailable — only descriptions are shown.',
  invalidTitle: 'Could not read descriptions: {{count}}',
  invalidText: 'These files are skipped and the rest are shown. Fix them and they will appear.',
};
