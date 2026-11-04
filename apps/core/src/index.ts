import { bootCore, CoreHomeBusy } from './bootstrap/boot.ts';
import { runCaptureCommand } from './bootstrap/capture-command.ts';
import { CAPTURE_COMMAND, MUTATE_COMMAND } from './bootstrap/dev-commands.ts';
import {
  busyExitCode,
  homeFromArgv,
  KEEPALIVE_COMMAND,
  runKeepaliveCommand,
} from './bootstrap/keepalive-command.ts';
import { defaultCoreHome } from './platform/core-home.ts';
import { recordExit } from './platform/exit-record.ts';
import { userGatewayPlanOf } from './bootstrap/user-gateway-wiring.ts';
import { localFrontPortOf } from './routes/local/own/front.ts';
import { runMutateCommand } from './verifier/mutate/index.ts';

/**
 * Вход процесса ядра (`pnpm core`). Ядро — отдельный процесс рядом с панелью (F12): панель
 * говорит с ним по HTTP на 127.0.0.1, адрес — в `<core home>/procs.json`.
 *
 * `index.ts keepalive install|remove|status …` — автозапуск ядра при входе (P57): команда
 * ставит или снимает запись ОС и выходит, ядро не загружая. `--home <dir>` — дом ядра (так его
 * запускает автозапуск); без него — `AGENTDECK_CORE_HOME` или `~/.agentdeck/core`.
 *
 * Выход ядра (и падение на загрузке) оставляет `<home>/core.exit.json` — код выхода для
 * карточки сбоя панели, которая на Windows сама его не видит.
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
  const exit = recordExit(home ?? defaultCoreHome());
  // Постоянный адрес своей модели — только настоящему ядру, не тестовым загрузкам.
  const frontPort = localFrontPortOf(process.env);
  // Шлюз человека: ядро на доме человека — порт из настроек панели (5179), стенд — по окружению.
  const userGatewayPlan = userGatewayPlanOf(process.env, home);
  const core = await bootCore({
    ...(home ? { home } : {}),
    ...(frontPort ? { localFront: { port: frontPort } } : {}),
    ...(userGatewayPlan
      ? {
          userGateway: {
            port: userGatewayPlan.kind === 'fixed' ? userGatewayPlan.port : ('panel' as const),
          },
        }
      : {}),
    // Прокси защиты данных человека — только настоящему ядру, по настройкам панели (C3c).
    dlpProxy: {},
    log: (line) => console.log(line),
  }).catch((error: unknown) => {
    // Дом уже занят живым ядром — код 3 (как у занятого хоста звеньев): сторож панели отличает
    // «второе лишнее» от падения и усыновляет первое по procs.json. Под автозапуском ОС — код 0,
    // чтобы systemd и launchd не перезапускали лишнее ядро без конца.
    if (!(error instanceof CoreHomeBusy)) throw error;
    console.error(`agentdeck core: ${error.message}`);
    process.exit(busyExitCode(process.env));
  });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    exit.noteSignal(signal);
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
