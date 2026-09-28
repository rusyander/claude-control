import type {
  ProjectTestAutomationCommand,
  ProjectTestE2eFolder,
  ProjectTestE2eRun,
} from '@agentdeck/contracts';

export interface TestE2eRunProps {
  path: string | undefined;
  folder: ProjectTestE2eFolder;
  run: ProjectTestE2eRun | undefined;
  /** Окружение пульта: его адрес стенда и секреты уходят в команду. */
  environmentId?: string;
  /** Идёт прогон агента — он пишет в те же файлы, запуск сервер всё равно отклонит. */
  isAgentRunning: boolean;
  /** Своя команда проекта: ею гонится, когда папки с тестами нет. */
  automation?: ProjectTestAutomationCommand;
  /**
   * Открытая группа, сколько разных файлов автотестов у её кейсов и какие —
   * для «Только группа»: по путям видно, погонит ли сервер её своей командой.
   */
  group?: { id: string; title: string; files: number; paths: string[] };
}
