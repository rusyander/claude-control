/**
 * Общее начало запроса у копий одной группы (X1 плана экономии): две копии
 * подряд, настоящий `claude` на стабе модели, настоящий реестр прогонов с
 * проводкой строки о тестах панели (`wireTestsChatNote`) и профилем группы.
 * Системный промпт копий обязан совпасть байт в байт — кэш начала запроса
 * между копиями делится только так. Два красных контроля в том же прогоне:
 * строка о тестах с путём копии и профиль без флага выноса личных секций —
 * оба обязаны разойтись, иначе сравнение ничего не видит.
 *
 * Запуск: `node tools/qa/check-group-shared-prefix.mjs`. Нужен установленный
 * `claude` (путь — `CLAUDE_CLI`); стенд и настоящий конфиг не трогаются.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./check-run-layers.mjs', import.meta.url)), '--shared-prefix'],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(run.status ?? 1);
