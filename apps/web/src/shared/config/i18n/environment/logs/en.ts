import type { environmentLogsRu } from './ru.ts';

/** English texts of the “Logs” tab; typed against the Russian module. */
export const environmentLogsEn: typeof environmentLogsRu = {
  sources: {
    label: 'Sources',
    run: 'Dev server',
    compose: 'Docker Compose',
    all: 'All services',
    allHint: 'Lines of every service together, by time — each one names its service',
    state: {
      starting: 'starting',
      running: 'running',
      stopped: 'stopped',
      error: 'crashed',
      exited: 'stopped',
      restarting: 'restarting',
      created: 'not started',
      paused: 'paused',
      dead: 'broken',
    },
    emptyTitle: 'No logs yet',
    emptyText:
      'Targets started from “Dev server” in the chat header and the project’s Docker Compose services show up here. Start something — the list updates by itself.',
    dockerMissing: 'Docker is not installed — there will be no Compose service logs.',
    dockerStopped: 'Docker is not running — Compose service logs appear once it is up.',
  },
  toolbar: {
    search: 'Search lines',
    searchPlaceholder: 'Text, error code, request id…',
    matches: '{{shown}} of {{total}}',
    level: 'Level',
    levelHint: 'Lines at “{{level}}” level and above',
    levels: {
      all: 'All',
      error: 'Errors',
      warn: 'Warnings',
      info: 'Info',
      debug: 'Debug',
    },
    follow: 'Follow',
    followHint: 'Scroll to new lines as soon as they arrive',
    clear: 'Clear',
    clearHint: 'Remove the lines shown — only new ones will appear from now on',
  },
  view: {
    label: 'Log lines of “{{source}}”',
    loading: 'Reading the log…',
    empty: 'The source has not written anything yet.',
    emptyFiltered: 'Nothing matches the filter.',
    resetFilter: 'Reset filter',
    newLines_one: 'To the new line ({{count}})',
    newLines_few: 'To new lines ({{count}})',
    newLines_many: 'To new lines ({{count}})',
    newLines_other: 'To new lines ({{count}})',
    idleRun: 'The target is stopped — showing the output of its last run.',
    idleCompose: 'The service is not running — showing the lines docker kept.',
    truncated: 'Showing the last {{count}} lines — earlier ones were pushed out.',
    stderr: 'stderr',
    levelTag: { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' },
  },
  detail: {
    fields: 'Record fields',
    copy: 'Copy line',
    copied: 'Copied',
    ask: 'Analyse in chat',
    askHint:
      'The window closes and the chat input gets a request to the agent with the line and 20 lines around it (secrets masked) — you send it yourself',
  },
  askPrompt:
    'Analyse a line from the project log “{{source}}”: find where in the code it comes from and explain the cause. If it is an error, propose a fix, but do not apply it without my confirmation.\n\nLine:\n```\n{{line}}\n```\n\nLines around it ({{count}}, secrets masked):\n```\n{{snippet}}\n```',
  errors: {
    unregistered:
      'The panel shows logs only for projects from the “Projects” section — logs can carry tokens and passwords.',
    docker: 'Docker did not return the logs: {{detail}}',
    sourceGone: 'The source is gone — the list is refreshed.',
    generic: 'Could not read the log: {{message}}',
    retrying: 'Retrying in a few seconds; the lines shown stay.',
  },
};
