import type { ProjectTestAutomationCommand, ProjectTestE2eFolder } from '@agentdeck/contracts';

/** Чем сервер погонит прогон: командой папки e2e, своей командой проекта или ничем. */
export type E2eRunChoice = 'folder' | 'own' | 'none';

export interface E2eRunChoiceInput {
  folder: ProjectTestE2eFolder;
  automation?: ProjectTestAutomationCommand;
  /** `automation.file` кейсов запуска; нет — весь набор. */
  files?: readonly string[];
}

/**
 * Повтор выбора сервера (`E2eRuns.plan`, e2e-run.ts): команда папки есть, когда
 * папка на месте и каркас узнан; ею гонится, если своей команды нет или все
 * файлы запуска лежат в папке и тесты в ней есть. Иначе — своя команда.
 *
 * Отдельной функцией, а не условием в карточке: карточка считала выбор только
 * по папке, и «Только группа» с файлами вне e2e/ шла своей командой, а строки
 * «Своя команда проекта» под кнопкой не было (F-324).
 */
export function e2eRunChoice({ folder, automation, files }: E2eRunChoiceInput): E2eRunChoice {
  const hasFolderCommand =
    folder.state !== 'missing' && Boolean(folder.dir) && folder.framework !== 'unknown';
  const prefix = folder.dir ? `${folder.dir.replace(/\/+$/, '')}/` : '';
  const inFolder = !files || (prefix !== '' && files.every((file) => file.startsWith(prefix)));
  if (hasFolderCommand && (!automation || (inFolder && folder.specs > 0))) return 'folder';
  return automation ? 'own' : 'none';
}
