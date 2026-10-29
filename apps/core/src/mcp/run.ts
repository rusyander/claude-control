import { runBridge } from './main.ts';

// Процесс моста: код выхода 2 — мост не стартовал (нет окружения сессии или имени моста).
// stdin закрыт — мост уходит, даже если повтор к ядру ещё ждёт: ответ читать некому (core-s2 F-91).
void runBridge(process.argv[2]).then((code) => {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
});
