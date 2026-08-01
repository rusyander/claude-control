import type { AutostartMemory, AutostartReport } from './project-runner.types.ts';
import type { ProjectRunnerRegistry } from './registry.ts';

/**
 * Поднять dev-серверы целей, отмеченных автозапуском. Вызывается один раз при
 * старте сервера панели.
 *
 * Два обещания: браузер не открывается; ни одна неудача не роняет старт панели
 * (каталог могли удалить, скрипт — убрать).
 */
export async function autostartProjects(
  registry: ProjectRunnerRegistry,
  memory: AutostartMemory,
): Promise<AutostartReport> {
  const report: AutostartReport = { started: [], failed: [] };
  for (const prefs of memory.listAutostartProjects()) {
    try {
      const view = await registry.start(
        { projectPath: prefs.projectPath ?? prefs.path, dir: prefs.dir },
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
