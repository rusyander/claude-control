import type { InstructionsDraft } from './model/useInstructionsDraft';

export interface ProjectTabProps {
  /** id проекта из реестра — по нему адресуются проектные конфиги. */
  projectId: string;
}

export interface ProjectFileTabProps extends ProjectTabProps {
  /** Корень проекта — строка источника строит из него путь к файлу вкладки. */
  projectPath: string;
}

export interface ProjectRulesTabProps {
  /** Черновик файла инструкций — живёт у панели проекта, выше вкладок. */
  draft: InstructionsDraft;
}
