import { bootCore } from './bootstrap/boot.ts';
import { runCaptureCommand } from './bootstrap/capture-command.ts';
import { CAPTURE_COMMAND, MUTATE_COMMAND } from './bootstrap/dev-commands.ts';
import {
  homeFromArgv,
  KEEPALIVE_COMMAND,
  runKeepaliveCommand,
} from './bootstrap/keepalive-command.ts';
import { runMutateCommand } from './verifier/mutate/index.ts';

/**
 * Вход процесса ядра (`pnpm core`). Ядро — отдельный процесс рядом с панелью (F12): панель
 * говорит с ним по HTTP на 127.0.0.1, адрес — в `<core home>/procs.json`.
 *
 * `index.ts keepalive install|remove|status …` — автозапуск ядра при входе (P57): команда
 * ставит или снимает запись ОС и выходит, ядро не загружая. `--home <dir>` — дом ядра (так его
 * запускает автозапуск); без него — `AGENTDECK_CORE_HOME` или `~/.agentdeck/core`.
 */

const argv = process.argv.slice(2);
const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

if (argv[0] === KEEPALIVE_COMMAND) {
  process.exitCode = await runKeepaliveCommand(argv.slice(1), io);
} else if (argv[0] === MUTATE_COMMAND) {
  process.exitCode = await runMutateCommand(argv.slice(1), io);
} else if (argv[0] === CAPTURE_COMMAND) {
  process.exitCode = await runCaptureCommand(argv.slice(1), io);
} else {
  const home = homeFromArgv(argv);
  const core = await bootCore({
    ...(home ? { home } : {}),
    log: (line) => console.log(line),
  });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`agentdeck core: ${signal}, stopping`);
    core.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('agentdeck core: stop failed', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
