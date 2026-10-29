import type { CliRunFacts } from './types.ts';

/** Cursor (`cursor-agent`). Источник — каталог панели `providers/catalog/cursor.ts` до переезда. */
export const cursorRunFacts: CliRunFacts = {
  id: 'cursor',
  name: 'Cursor',
  status: 'experimental',
  binary: { command: 'cursor-agent', windowsCommand: 'cursor-agent.cmd' },
  // Способ входа `cursor-agent` ни код, ни документация панели не описывают.
  login: 'unknown',
  // Собственного модельного API нет, и запуск через CLI панель не поддерживает.
  vendorApi: { kind: 'none', keyVars: [] },
  cliRunnable: false,
  // Канала адреса нет: ни переменной, ни места в конфиге документация не называет.
  channels: [],
};
