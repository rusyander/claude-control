import { coded } from '../../lib/server-text/server-text.ts';
import { RunnerError, type AutostartMemory, type AutostartReport } from './project-runner.types.ts';
import type { ProjectRunnerRegistry } from './registry.ts';

/**
 * Поднять dev-серверы целей, отмеченных автозапуском. Вызывается один раз при
 * старте сервера панели.
 *
 * Два обещания: браузер не открывается; ни одна неудача не роняет старт панели
 * (каталог могли удалить, скрипт — убрать).
 *
 * `isAllowed` — граница проектов панели (F-16): отметка у чужого каталога,
 * записанная до границы или руками в файле, не исполняет его команду, а уходит
 * в отчёт отказом — человек видит её в сводке старта.
 */
export async function autostartProjects(
  registry: ProjectRunnerRegistry,
  memory: AutostartMemory,
  isAllowed: (projectPath: string) => boolean = () => true,
): Promise<AutostartReport> {
  const report: AutostartReport = { started: [], failed: [] };
  for (const prefs of memory.listAutostartProjects()) {
    try {
      const projectPath = prefs.projectPath ?? prefs.path;
      if (!isAllowed(projectPath)) {
        throw coded(
          new RunnerError(
            'bad-path',
            'Dev-сервер панель запускает только у проектов из раздела «Проекты», каталогов внутри них и копий их веток. Добавьте этот каталог проектом.',
          ),
          'runner-project-unregistered',
        );
      }
      const view = await registry.start(
        { projectPath, dir: prefs.dir },
        { command: prefs.command, port: prefs.pinnedPort, openBrowser: false },
      );
      report.started.push({ path: view.path, port: view.port });
    } catch (error) {
      report.failed.push({
        path: prefs.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
