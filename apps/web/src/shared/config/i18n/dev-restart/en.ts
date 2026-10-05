import type { devRestartRu } from './ru.ts';

/** English texts of the deferred dev-server restart banner; typed against the Russian module. */
export const devRestartEn: typeof devRestartRu = {
  title: 'Server edits are waiting for a restart',
  waitingRuns: 'The server restarts on its own once the running chat turns finish.',
  waitingSetup: 'The server restarts on its own once split groups finish preparing their copies.',
  waitingBoth:
    'The server restarts on its own once the running turns and group copy preparation finish.',
  since: 'Waiting since {{time}}',
  files_one: '{{count}} file edited: {{names}}',
  files_few: '{{count}} files edited: {{names}}',
  files_many: '{{count}} files edited: {{names}}',
  files_other: '{{count}} files edited: {{names}}',
  restartNow: 'Restart now',
  requested: 'Restart requested — the watcher will do it within seconds',
  confirmTitle: 'Restart the server now?',
  confirmText:
    'Running chat turns and copy preparation will be cut off midway. Conversations are kept, but their current turn will have to be continued again.',
  confirm: 'Restart',
  failed: 'Could not pass the restart request on: {{message}}',
};
