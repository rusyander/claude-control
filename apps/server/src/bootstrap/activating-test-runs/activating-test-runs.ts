import type { ProjectTestRun } from '@agentdeck/contracts';
import { ProjectTestRunRegistry } from '../../domains/project-tests/project-tests.ts';

/**
 * Реестр прогонов тестов, включающий переходник MCP на старте.
 *
 * Наследование, а не правка реестра: включение — обстоятельство внешнего мира
 * (есть ли привязка, зарегистрирован ли сервер), и реестру прогонов о нём знать
 * нечего. Включаем ДО запуска: агент стартует тут же, и запись, включённая
 * после, досталась бы только следующему прогону.
 */
export class ActivatingTestRunRegistry extends ProjectTestRunRegistry {
  private readonly onStart: (projectPath: string) => void;

  constructor(onStart: (projectPath: string) => void) {
    super();
    this.onStart = onStart;
  }

  // Все аргументы — дальше как есть: прежде сюда доходили только заявка и время,
  // и материал генерации, доступы стенда и выбор папки e2e терялись на стенде.
  override start(...args: Parameters<ProjectTestRunRegistry['start']>): ProjectTestRun {
    // `activateAtlassianMcp` не бросает по своему устройству: интеграция не
    // главнее работы, и прогон обязан пойти даже с мёртвым переходником.
    this.onStart(args[0].projectPath);
    return super.start(...args);
  }
}
