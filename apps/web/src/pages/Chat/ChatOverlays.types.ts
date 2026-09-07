import type { Artifact } from '@agentdeck/contracts';
import type { CascadeCeiling } from '@agentdeck/contracts/model-cascade';
import type { ProjectInfo } from '@entities/Project';
import type { ParallelChoice } from '@features/ParallelLaunch';

/** Окна поверх чата: выбор папки, подтверждение удаления, код, тесты, запуск. */
export interface ChatOverlaysProps {
  /** Выбор папки проекта. */
  isFolderPickerOpen: boolean;
  onFolderPickerOpenChange: (open: boolean) => void;
  onPickFolder: (path: string, name: string) => void;

  /** Удаление артефакта: окно живёт, пока выбран файл. */
  artifactToDelete?: Artifact;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  isDeleting: boolean;

  /**
   * Код и тесты открываются только у проекта: в песочнице этих кнопок нет, и
   * окна без каталога показывать нечего.
   */
  isProjectContext: boolean;
  projectPath?: string;
  /** Разговор нужен коду проекта: дифф показывает правки ИМЕННО этого чата. */
  activeChatId?: string;
  isCodeOpen: boolean;
  onCodeOpenChange: (open: boolean) => void;
  isTestsOpen: boolean;
  onTestsOpenChange: (open: boolean) => void;

  /** Параллельный запуск агентов по нескольким проектам. */
  isParallelOpen: boolean;
  onParallelOpenChange: (open: boolean) => void;
  projects: ProjectInfo[];
  /**
   * Потолок разговора: от него окно веера отсчитывает ступени вниз.
   *
   * Пара самого разговора, независимо от правила подбора в проекте: здесь модель
   * выбирает ЧЕЛОВЕК, как в шапке чата, а правило выключает автоматический
   * подбор. Иначе запуск с домашней вкладки, где проекта нет вовсе, остался бы
   * без выбора — а веер по нескольким проектам чаще всего уходит именно оттуда.
   */
  parallelCeiling?: CascadeCeiling;
  onLaunch: (
    selected: ProjectInfo[],
    prompt: string,
    allowEdits: boolean,
    choice?: ParallelChoice,
  ) => void;
}
