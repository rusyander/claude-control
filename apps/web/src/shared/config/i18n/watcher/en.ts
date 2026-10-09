import type { watcherRu } from './ru.ts';

/** English texts of the background watcher; typed against the Russian module. */
export const watcherEn: typeof watcherRu = {
  title: 'Background watcher',
  short: 'Watcher',
  tooltip: 'The agent is running in the background and collecting information',
  indicatorAria: 'Background watcher is on: running {{time}}, spend {{spend}}',
  running: 'Running {{time}}',
  spend: 'Spend: {{spend}}',
  spendEstimate: 'estimate at API rates',
  runs_one: '{{count}} analysis',
  runs_few: '{{count}} analyses',
  runs_many: '{{count}} analyses',
  runs_other: '{{count}} analyses',
  findings_one: '{{count}} section in the report',
  findings_few: '{{count}} sections in the report',
  findings_many: '{{count}} sections in the report',
  findings_other: '{{count}} sections in the report',
  remarks_one: '{{count}} of them a remark',
  remarks_few: '{{count}} of them remarks',
  remarks_many: '{{count}} of them remarks',
  remarks_other: '{{count}} of them remarks',
  pending_one: 'Waiting for analysis: {{count}} problem',
  pending_few: 'Waiting for analysis: {{count}} problems',
  pending_many: 'Waiting for analysis: {{count}} problems',
  pending_other: 'Waiting for analysis: {{count}} problems',
  analyzing: 'Analysing',
  turnOff: 'Turn off',
  start: 'Start the watcher',
  stop: 'Stop',
  offShort: 'off',
  offTooltip: 'The watcher is off. Open its page to start it.',
  offAria: 'Background watcher is off — open its page',
  openPage: 'Open page',
  toggleLabel: 'Background watcher',
  toggleHint:
    'While on, the panel collects all of its own problems: on the server — 5xx and 4xx ' +
    'responses caused by its own interface, log errors and warnings, slow responses, CLI ' +
    'runs that failed or exited with an error; on the page — errors, console warnings, ' +
    'failed requests, wrongly shaped replies, stuck loading. A cheap model checks each one ' +
    "against the panel's source code and adds remarks about defects it notices nearby. " +
    'The model only reads code and changes nothing.',
  cardHint:
    'Each cause is one report section numbered WR-n: kind (failure or remark), severity, ' +
    'check status, place in the code, root cause, steps, how to fix, evidence with secrets ' +
    'removed and the number of repeats; an index sits on top. The report is written so ' +
    'another agent can pick it up. Analyses stay under an hourly cap; no problems — no ' +
    'spend. Turned off, the watcher collects nothing.',
  reportEmpty: 'No file yet — it appears with the first finding.',
  offState: 'Off',
  toggleFailed: 'Could not switch the watcher: {{message}}',
  statusFailed: 'Could not read the watcher state: {{message}}',
  problemTitle: 'The watcher cannot do its job',
  bug: {
    title: 'Found a bug yourself?',
    hint:
      'Describe what broke and where. The watcher checks it against the panel code: only a ' +
      'confirmed defect goes into the report, and the answer shows up here.',
    label: 'What broke',
    placeholder: 'For example: in chat the group card does not change after “Accept”',
    check: 'Check',
    sent: 'Sent for checking',
    failed: 'Could not send for checking: {{message}}',
    recent: 'Your checks',
    off: 'You can describe a bug in words once the watcher is running: its model does the check.',
    state: {
      checking: 'checking',
      confirmed: 'confirmed — {{ref}}',
      confirmedNoRef: 'confirmed',
      rejected: 'not confirmed by the code',
      unclear: 'the model could not decide',
      failed: 'check failed',
    },
    stateHint: {
      checking: 'The model is reading the panel code. Usually a minute or two.',
      confirmed: 'The defect is in the code — its section is in the report.',
      rejected: 'Not written to the report: the model found no such defect in the code.',
      unclear: 'Not written to the report: the model could not decide. Add detail and check again.',
      failed: 'The analysis failed — the entry is retried with the next analysis.',
    },
  },
  page: {
    title: 'Watcher',
    subtitle:
      'A background agent collects the panel’s problems and checks them against its code. ' +
      'Here you start it, describe a bug you found in words and read the report.',
    reportTitle: 'Report',
    reportHint:
      'Everything the watcher found and checked against the panel code: failures, remarks ' +
      'and bugs confirmed from your descriptions. The same file you hand to an agent.',
    empty: 'The report is empty',
    emptyText: 'There is no file yet — it appears with the watcher’s first finding.',
    noMatch: 'No sections in this filter.',
    loadFailed: 'Could not read the report',
    file: 'File',
    updated: 'Updated {{date}}',
    filter: {
      all: 'All · {{count}}',
      failure: 'Failures · {{count}}',
      remark: 'Remarks · {{count}}',
      confirmed: 'Confirmed · {{count}}',
    },
    filterLabel: 'Section filter',
    count: 'Repeats: {{count}}',
    seen: 'First {{first}} · last {{last}}',
    location: 'Code location',
    expand: 'Details',
    collapse: 'Collapse',
    severity: {
      critical: 'critical',
      high: 'high',
      medium: 'medium',
      low: 'low',
    },
    verdict: {
      confirmed: 'confirmed',
      'not-in-code': 'not in code',
      unclear: 'unclear',
      pending: 'checking',
    },
    entryClass: { failure: 'failure', remark: 'remark' },
  },
  problem: {
    cli_missing:
      'Claude Code was not found: problems are collected and written to the report, but ' +
      'nothing can check them against the code. Install the CLI and restart the panel.',
    report_unwritable:
      'The report cannot be written: no access to the file or its folder. Failures are ' +
      'not lost — the panel keeps them, and analysed ones reach the report once the file ' +
      'is reachable.',
    analysis_failed:
      'The last analysis failed. The problems stay in the report as “checking” and go to ' +
      'the model with the next one — the analysis does not retry in a loop on its own.',
    hourly_cap:
      'The hourly analysis cap is reached. Problems are still written to the report as ' +
      '“checking”; the analysis resumes on its own once the hour frees a slot.',
    route_refused:
      'The analysis did not start: the chosen route does not allow it, and the panel will ' +
      'not substitute another one. Problems stay in the report as “checking”. The reason is below.',
  },
};
