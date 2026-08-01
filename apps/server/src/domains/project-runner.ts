/**
 * Запуск и остановка dev-серверов проекта прямо из панели.
 *
 * Запускается не «проект», а ЦЕЛЬ — каталог с собственным package.json: сам
 * корень или пакет монорепозитория. Целей у одной вкладки может работать
 * несколько сразу, ключ реестра — абсолютный путь каталога запуска.
 *
 * ПОРТ ПАНЕЛЬ НЕ НАЗНАЧАЕТ. Раньше она выбирала свободный порт и передавала его
 * в `PORT`; так работают только create-react-app и Next, а Vite, Angular и любой
 * сервер с портом в конфиге эту переменную игнорируют — панель ждала адрес, по
 * которому никто не слушает. Теперь порт ЧИТАЕТСЯ из вывода dev-сервера: строку
 * вида «Local: http://localhost:5173» печатают все. Закрепить порт можно вручную —
 * тогда `PORT` передаётся и ожидание идёт по нему.
 *
 * Чистые части (разбор вывода, поиск целей, выбор команды и пакетного менеджера)
 * вынесены отдельными функциями — их проверяют тесты без настоящего dev-сервера.
 * Открытие браузера инъектируется, чтобы тест его не звал.
 *
 * Этот файл — фасад: реализация разложена по `project-runner/` (цели проекта,
 * стек, порты, разбор вывода, реестр процессов), а маршруты и тесты продолжают
 * импортировать всё отсюда.
 */

export {
  RunnerError,
  type AutostartMemory,
  type AutostartReport,
  type LaunchSpec,
  type PackageManager,
  type RunnerDeps,
  type RunnerTargetRef,
  type RunnerTargetSpec,
  type TargetMemory,
} from './project-runner/project-runner.types.ts';
export {
  detectPackageManager,
  detectRunScript,
  resolveRunCommand,
  tokenize,
} from './project-runner/stack.ts';
export {
  describeRunner,
  expandWorkspacePattern,
  listRunnerTargets,
  resolveTargetDir,
  workspacePatterns,
} from './project-runner/targets.ts';
export { extractBusyPort, extractServerPort } from './project-runner/output.ts';
export { describePort, findPortHolders, freePort, isPortBusy } from './project-runner/ports.ts';
export { openBrowser } from './project-runner/os-process.ts';
export { ProjectRunnerRegistry } from './project-runner/registry.ts';
export { autostartProjects } from './project-runner/autostart.ts';
