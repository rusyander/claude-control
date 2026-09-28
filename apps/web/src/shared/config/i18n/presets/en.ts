import type { PresetsDictionary } from './presets.types.ts';

/**
 * English texts of the ready-made presets, keyed by preset id. Completeness
 * against the preset lists is checked by `../preset-text.test.ts`.
 */
export const presetsEn: PresetsDictionary = {
  permission: {
    'read-any': {
      title: 'Read any file',
      description: 'Claude may open project files without asking.',
    },
    'edit-any': {
      title: 'Edit files',
      description: 'Changing existing files.',
    },
    'write-any': {
      title: 'Create files',
      description: 'Creating new files and overwriting existing ones.',
    },
    'bash-any': {
      title: 'Any shell command',
      description: 'Full terminal access. The broadest permission there is.',
    },
    'bash-npm': {
      title: 'npm run commands',
      description: 'Project scripts only: build, tests, lint.',
    },
    'bash-rm': {
      title: 'Deleting files from the shell',
      description: 'The rm command. Usually it goes on the deny list.',
    },
    'git-status': {
      title: 'Repository status',
      description: 'Reading the git status is safe.',
    },
    'git-commit': {
      title: 'Commits',
      description: 'Creating commits in the repository.',
    },
    'git-push': {
      title: 'Push to a remote repository',
      description: 'Changes go to the server and the team sees them.',
    },
    'web-fetch': {
      title: 'Fetching pages',
      description: 'Claude may download the content behind links.',
    },
    'web-search': {
      title: 'Web search',
      description: 'Search queries to external services.',
    },
    task: {
      title: 'Starting subagents',
      description: 'Claude may start background agents for large tasks.',
    },
    skill: {
      title: 'Calling skills',
      description: 'Loading your instruction sets.',
    },
  },
  mcp: {
    filesystem: {
      title: 'File system',
      description: 'Access to files in the given folders: read, write, search.',
    },
    github: {
      title: 'GitHub',
      description: 'Repositories, issues and pull requests on github.com.',
    },
    gitlab: {
      title: 'GitLab',
      description: 'Merge requests, branches, commits and comments in GitLab.',
    },
    postgres: {
      title: 'PostgreSQL',
      description: 'Reading the schema and running queries against the database.',
    },
    playwright: {
      title: 'Playwright',
      description: 'Driving a browser: open a page, click, take a screenshot.',
    },
    sse: {
      title: 'Local SSE server',
      description:
        'Connecting to a server that is already running at an address — Figma Dev Mode, for example.',
    },
  },
  hook: {
    'destructive-guard': {
      title: 'Destructive command guard',
      description: 'Stops dangerous Bash commands before they run and asks for confirmation.',
    },
    'secret-guard': {
      title: 'Secret guard',
      description: 'Checks file writes for strings that look like tokens.',
    },
    'format-on-save': {
      title: 'Format on save',
      description: 'Runs the formatter after a file is edited.',
    },
    'session-brief': {
      title: 'Session start brief',
      description: 'Shows a reminder or context at the start of a session.',
      message: 'Reminder: check .agent/notes.md before starting work.',
    },
    'precompact-checkpoint': {
      title: 'Checkpoint before compaction',
      description: 'Asks to write the state down before the context is compacted.',
      message: 'The context is about to be compacted — write your progress to .agent/PROGRESS.md.',
    },
  },
  hookEvent: {
    PreToolUse: {
      when: 'Before Claude calls a tool',
      useFor: 'Checks and bans: stop a dangerous command, require confirmation, log the intent.',
    },
    PostToolUse: {
      when: 'Right after a tool has finished',
      useFor: 'Reacting to the result: format the changed file, run the linter, record the event.',
    },
    UserPromptSubmit: {
      when: 'When you have sent a message, before Claude sees it',
      useFor: 'Add context to the request or remind the agent of a rule by keyword.',
    },
    Notification: {
      when: 'When Claude Code shows a notification',
      useFor: 'Forward the notification outside: a sound, a system window, a messenger message.',
    },
    Stop: {
      when: 'When Claude has finished answering',
      useFor: 'Final actions: build a report, signal that the work is done.',
    },
    SubagentStop: {
      when: 'When a subagent has finished',
      useFor: 'Processing the results of background tasks.',
    },
    SessionStart: {
      when: 'When a session starts or resumes',
      useFor:
        'Preparing context: show the repository state, remind of open tasks, check the environment.',
    },
    SessionEnd: {
      when: 'When a session ends',
      useFor: 'Cleanup: save notes, close temporary files.',
    },
    PreCompact: {
      when: 'Before the context is compacted because it is full',
      useFor: 'Write the important things to a file in time to restore the state after compaction.',
    },
  },
};
