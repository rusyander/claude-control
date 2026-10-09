import type { devRestartRu } from './ru.ts';

/** English texts of the deferred dev-server restart banner; typed against the Russian module. */
export const devRestartEn: typeof devRestartRu = {
  title: 'Server edits are waiting for a restart',
  waitingRuns: 'The server restarts on its own once the running chat turns finish.',
  waitingSetup: 'The server restarts on its own once split groups finish preparing their copies.',
  waitingChecks:
    'The server restarts on its own once the running project autotests and mutation checks finish.',
  waitingBoth:
    'The server restarts on its own once everything running finishes: chat turns, group copy preparation, autotests and checks.',
  since: 'Waiting since {{time}}',
  files_one: '{{count}} file edited: {{names}}',
  files_few: '{{count}} files edited: {{names}}',
  files_many: '{{count}} files edited: {{names}}',
  files_other: '{{count}} files edited: {{names}}',
  restartNow: 'Restart now',
  requested: 'Restart requested — the watcher will do it within seconds',
  confirmTitle: 'Restart the server now?',
  confirmText:
    'Chat turns carry on: the agent process survives the restart and the feed picks it up again. Group copy preparation and running autotests and project checks will be cut off midway.',
  confirm: 'Restart',
  failed: 'Could not pass the restart request on: {{message}}',
};
