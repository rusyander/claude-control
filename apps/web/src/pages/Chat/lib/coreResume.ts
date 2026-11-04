/**
 * «Продолжить через ядро» (этап 10, F2): разговор Claude Code, начатый в панели или терминале,
 * продолжает чат ядра на месте, в папке проекта. Продолжить можно только настоящий разговор —
 * его id и есть имя транскрипта Claude Code (UUID); черновик (`new-…`) и номер прогона панели
 * транскриптом не являются, и кнопки для них нет. Сеанс прогона точнее строки списка: после
 * ответа CLI в разговоре идёт именно он.
 */

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function coreResumeIdOf(
  sessionId: string | undefined,
  chatId: string | undefined,
): string | undefined {
  for (const id of [sessionId, chatId]) {
    if (id !== undefined && CLAUDE_SESSION_ID.test(id)) return id;
  }
  return undefined;
}

/** Адрес формы чата ядра: проект, CLI Claude и разговор, который продолжается. */
export function coreResumeSearch(
  projectPath: string,
  resume: string,
): { project: string; cli: 'claude'; resume: string } {
  return { project: projectPath, cli: 'claude', resume };
}
