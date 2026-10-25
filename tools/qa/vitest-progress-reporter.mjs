/**
 * Ход прогона vitest строками-метками для `tools/tests-cli.mjs run`.
 *
 * Зачем. Обычный отчёт vitest вне терминала печатает файл, только когда тот
 * закончился, а JUnit — только в конце прогона. Повисший файл поэтому молчал до
 * предела в 10 минут, и снятый по пределу прогон не называл, кто держал его
 * (группа 24.10.2026: дважды по 601 с, потом четыре ручных прогона, чтобы найти
 * файл). Метки идут из главного процесса vitest, и он их печатает, даже когда
 * воркер занят синхронным вызовом: начало файла видно сразу, итог теста — с
 * отставанием на один тест (воркер шлёт его пачкой, когда освобождается).
 *
 * Каждая метка — одна строка: `[agentdeck-vitest] {json}`.
 *   {"e":"start","file":…}                         файл начат
 *   {"e":"end","file":…}                           файл закончен
 *   {"e":"case","file":…,"name":…,"state":…,"ms":…,"limit":…}
 *                                                  итог теста; `limit` — предел из
 *                                                  «Test timed out in N ms», если тест
 *                                                  снят по нему, иначе null
 */
export const PROGRESS_MARK = '[agentdeck-vitest] ';

const TIMED_OUT = /(?:Test|Hook) timed out in (\d+)\s*ms/;

function mark(event) {
  process.stdout.write(`${PROGRESS_MARK}${JSON.stringify(event)}\n`);
}

/** Путь файла набора: у vitest 4 — `moduleId`, абсолютный. */
const fileOf = (testModule) => String(testModule?.moduleId ?? '').replaceAll('\\', '/');

/** Предел, по которому vitest снял тест, — из текста его ошибок. */
function limitOf(errors) {
  for (const error of errors ?? []) {
    const found = TIMED_OUT.exec(String(error?.message ?? ''));
    if (found) return Number(found[1]);
  }
  return null;
}

export default class AgentdeckProgressReporter {
  onTestModuleStart(testModule) {
    mark({ e: 'start', file: fileOf(testModule) });
  }

  onTestModuleEnd(testModule) {
    mark({ e: 'end', file: fileOf(testModule) });
  }

  onTestCaseResult(testCase) {
    const result = testCase.result?.() ?? {};
    const duration = testCase.diagnostic?.()?.duration;
    mark({
      e: 'case',
      file: fileOf(testCase.module),
      name: String(testCase.fullName ?? testCase.name ?? '').replace(/\s+/g, ' '),
      state: result.state ?? 'unknown',
      ms: Number.isFinite(duration) ? Math.round(duration) : null,
      limit: limitOf(result.errors),
    });
  }
}
