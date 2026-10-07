import type { WatcherTexts } from './ru';

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export const watcherEn: WatcherTexts = {
  chip: (time: string) => `Watcher · ${time}`,
  chipA11y: (time: string, state: string) =>
    `Background watcher is on, running ${time}${state ? `, ${state}` : ''}. Open the summary`,
  stateAnalyzing: 'analysing',
  stateProblem: 'has a problem',
  title: 'Background watcher',
  running: (time: string) => `Running ${time}`,
  analyzing: 'Analysing now',
  findings: (count: number, remarks: number) =>
    `${plural(count, 'section', 'sections')} in the report` +
    (remarks > 0 ? `, ${plural(remarks, 'remark', 'remarks')} among them` : ''),
  pending: (count: number) => `Waiting for analysis: ${plural(count, 'problem', 'problems')}`,
  hourlyCap: (used: number, limit: number) => `Analyses this hour: ${used} of ${limit}`,
  spend: (text: string) => `Spend: ${text}`,
  spendEstimate: 'estimate at API prices, not a bill',
  report: 'Report',
  problemTitle: 'The watcher cannot do its job',
  problem: {
    cli_missing:
      'Claude Code not found: problems are written to the report but cannot be checked against the code.',
    report_unwritable:
      'The report cannot be written: no access to the file. The panel keeps the failures meanwhile.',
    analysis_failed:
      'The last analysis failed. Its problems go to the model together with the next one.',
    hourly_cap: 'The hourly analysis cap is reached. Analysis resumes by itself next hour.',
    route_refused:
      'The analysis did not start: the chosen route does not allow it. The reason is in the watcher summary in the panel.',
  },
  turnOff: 'Turn off',
  turnOffFailed: (reason: string) => `Did not turn off: ${reason}`,
  onlyPanel: 'The watcher is turned on in the panel: Settings → General.',
  close: 'Close',
  duration: { h: 'h', m: 'm', s: 's' },
};
