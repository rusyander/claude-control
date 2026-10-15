export type SuiteStack = 'go' | 'js' | 'pytest' | 'jvm';

export interface DiscoveredSuite {
  /** Каталог от корня проекта, через `/`. */
  dir: string;
  key: string;
  stack: SuiteStack;
  /** Файлов тестов в каталоге (у JS — с подкаталогами, сведёнными сюда). */
  files: number;
  /** Сами файлы тестов от корня проекта, через `/`: из их тестов пишется текст кейса. */
  paths: string[];
}

export interface SuitesSync {
  suites: number;
  added: number;
  /** Кейсы-наборы, чей текст панель переписала по нынешним тестам каталога. */
  refreshed: number;
  groups: string[];
  /** Кейсы-наборы, чьего каталога больше нет: не удаляются, только называются. */
  missing: { groupId: string; caseId: string; dir: string }[];
  /** Обход упёрся в потолок: часть каталогов не просмотрена. */
  truncated: boolean;
  /** Рецепт, ставший командой прогона проекта (`adoptRunCommand`). */
  adopted?: string;
}
