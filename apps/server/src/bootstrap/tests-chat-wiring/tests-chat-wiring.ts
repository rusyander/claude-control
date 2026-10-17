import { existsSync, statSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectTestE2eSync } from '@agentdeck/contracts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ProviderChatService } from '../../domains/provider-chat/ProviderChatService/ProviderChatService.ts';
import { e2eFolderView, e2eLinkedRoot } from '../../domains/project-tests/e2e-folder/e2e-folder.ts';
import { e2eChatLine } from '../../domains/project-tests/e2e-chat.ts';
import { syncE2eIfChanged } from '../../domains/project-tests/e2e-sync/e2e-sync.ts';
import { readEnvironments } from '../../domains/project-tests/library/library.ts';
import { readAutomation } from '../../domains/project-tests/automation/automation.ts';
import {
  reconcileTurnHooks,
  syncSuitesOnce,
  testsHookScript,
} from '../../domains/project-tests/project-tests.ts';
import {
  writeQwenLimits,
  writeQwenSystemNote,
} from '../../domains/provider-chat/system-note/system-note.ts';
import { panelHomeDir } from '../../lib/brand.mjs';
import { getProvider } from '../../providers/registry.ts';

/**
 * Агент чата узнаёт о тестах проекта на КАЖДОМ старте: отправка человека, дети
 * разделения, звенья конвейера, продолжение в чистой сессии — всё проходит
 * через `ChatRunRegistry.start`, и строка ставится там, а не в каждом маршруте.
 *
 * Старт чата НИЧЕГО не пишет на диск — ни у проекта реестра, ни у чужого
 * каталога. Решение владельца: папку заводит добавление проекта (если своей нет),
 * кнопка раздела «Тесты» или первая генерация e2e; разговор о чём угодно в
 * проекте без папки получал бы `e2e/` и строку в `.git/info/exclude` молча.
 * Без папки строка только подсказывает, куда класть тесты.
 *
 * Чужие CLI получают ту же строку тем же решателем (`ProviderChatService`), а
 * конец хода любого из них сверяет папку, если агент её трогал. Копия ветки,
 * где папка лежит ссылкой на оригинал, говорит и сверяет от имени ОРИГИНАЛА:
 * тест лёг в его папку, и кейс должен появиться у него.
 */
export interface TestsChatWiringDeps {
  appData: string;
  chatRuns: Pick<ChatRunRegistry, 'setWorkspaceNote'>;
  providerChats?: Pick<
    ProviderChatService,
    'setWorkspaceNote' | 'setSystemNote' | 'setLocalLimits'
  >;
  /** Прогон раздела «Тесты» пишет в файлы групп — сверка поверх него потеряла бы правку. */
  isBusy?: (path: string) => boolean;
  now?: () => string;
  log?: (message: string, error: unknown) => void;
}

/**
 * Кто сейчас пишет в файлы групп проекта: прогон агента раздела или автотесты
 * (на закрытии они кладут результаты в те же файлы). Один предикат на конец
 * хода чата и наблюдателя папки e2e — прежде конец хода знал только о первом и
 * переписывал группы посреди автотестов. Путь — в любом написании: реестры
 * находят проект сами.
 */
export function projectTestsBusy(
  runs: { holds: (path: string) => string | undefined },
  e2eRuns: { isRunning: (path: string) => boolean },
): (path: string) => boolean {
  return (path) => runs.holds(path) !== undefined || e2eRuns.isRunning(path);
}

/**
 * Хуки блока во всех проектах реестра (решение владельца 15.10): проверка конца
 * хода работает в любом Claude Code над проектом, а не только в чате панели.
 * Выключенный человеком проект не трогается. Свои каталоги панели — не проекты.
 */
export function reconcileProjectTurnHooks(
  appData: string,
  roots: readonly string[],
  log?: (message: string, error: unknown) => void,
): void {
  reconcileTurnHooks(
    appData,
    roots.filter((root) => !isInside(panelHomeDir(), root)),
    testsHookScript(),
    log,
  );
}

/**
 * Каталоги с тестами зарегистрированных проектов — в кейсы-наборы, по проекту за
 * шаг цикла событий: обход большого репозитория идёт синхронно, и разом по всем
 * проектам он держал бы запросы. Каждый проект — один раз (`syncSuitesOnce`).
 */
export function reconcileProjectSuites(
  appData: string,
  roots: readonly string[],
  log?: (message: string, error: unknown) => void,
): void {
  const queue = roots.filter((root) => existsSync(root) && !isInside(panelHomeDir(), root));
  const step = (): void => {
    const root = queue.shift();
    if (!root) return;
    try {
      syncSuitesOnce(appData, root, new Date().toISOString());
    } catch (error) {
      log?.('test suites sync failed', error);
    }
    setImmediate(step);
  };
  setImmediate(step);
}

/** CLI раздела тестов — абсолютным путём: агент вызывает его из каталога проекта. */
export function testsCliPath(): string {
  return fileURLToPath(new URL('../../../../../tools/tests-cli.mjs', import.meta.url));
}

function isInside(parent: string, target: string): boolean {
  const step = relative(resolve(parent), resolve(target));
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/** Проект каталога разговора: сам каталог или оригинал копии; `undefined` — не проект. */
function projectOf(cwd: string): string | undefined {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return undefined;
  // Свои чаты панели и песочницы — не проекты: тестировать там нечего.
  if (isInside(panelHomeDir(), cwd)) return undefined;
  return e2eLinkedRoot(cwd) ?? cwd;
}

/** Строка для каталога прогона; `undefined` — каталог не проект (песочница панели). */
export function testsChatNote(
  deps: TestsChatWiringDeps,
  at: string,
  group = false,
): string | undefined {
  const cwd = projectOf(at);
  if (!cwd) return undefined;
  const folder = e2eFolderView(cwd, deps.appData);
  let hasStandUrl = false;
  try {
    hasStandUrl = readEnvironments(cwd).some((item) => !item.archived && Boolean(item.baseUrl));
  } catch {
    // Битый файл окружений — спросим адрес, как будто его нет.
  }
  // Сломанный automation.json — как будто его нет: причину покажет раздел «Тесты».
  // Своя команда проекта гоняет КОД каталога: у копии ветки — её правки, а не
  // оригинал, на который ссылается папка e2e. Своя команда копии (её
  // `.agent/tests` переезжает зеркалом) — и прогон от имени копии.
  const copyAutomation = cwd !== at ? readAutomation(at).automation : undefined;
  const automation = copyAutomation ?? readAutomation(cwd).automation;
  return e2eChatLine({
    root: cwd,
    commandRoot: copyAutomation ? at : cwd,
    folder,
    cliPath: testsCliPath(),
    hasStandUrl,
    automation,
    ...(group ? { group } : {}),
  });
}

/**
 * Конец хода в каталоге `at`: папку e2e трогали после `startedAt` — сверить.
 * Сбой сверки ход не портит: он уже кончился, а причина уходит в журнал.
 */
export function testsChatFinished(
  deps: TestsChatWiringDeps,
  at: string | undefined,
  startedAt: number,
): ProjectTestE2eSync | undefined {
  // Под защитой и поиск проекта, и `isBusy`: сбой здесь вылетал из планировщика
  // конца хода, и доставка итога с надзором повторов пропускались (F-143).
  try {
    const cwd = at ? projectOf(at) : undefined;
    if (!cwd || deps.isBusy?.(cwd)) return undefined;
    return syncE2eIfChanged(cwd, startedAt, deps.now?.() ?? new Date().toISOString(), deps.appData);
  } catch (error) {
    deps.log?.('e2e folder sync after the chat turn failed', error);
    return undefined;
  }
}

export function wireTestsChatNote(deps: TestsChatWiringDeps): {
  finished: (cwd: string | undefined, startedAt: number) => ProjectTestE2eSync | undefined;
} {
  deps.chatRuns.setWorkspaceNote((cwd, run?: { group: boolean }) =>
    testsChatNote(deps, cwd, run?.group),
  );
  // Группа чужого CLI — той же строкой, что группа Claude (ревью A2-F10): обычная
  // зовёт спросить человека, а группа идёт без человека и встала бы на вопросе.
  deps.providerChats?.setWorkspaceNote((cwd, run) => testsChatNote(deps, cwd, run?.group));
  // Тот же файл системных настроек, что везёт группы Qwen, везёт и строку — в
  // системный промпт, а не в слова человека. Незнакомый id реестр откатывает на
  // Claude, у которого слоя нет, — строка остаётся в реплике.
  deps.providerChats?.setSystemNote((providerId, note, env) =>
    getProvider(providerId).groupLayer === 'qwen-system-settings'
      ? writeQwenSystemNote({ appData: deps.appData, note, env })
      : undefined,
  );
  // Окно и сроки локальной модели — тем же файлом настроек Qwen (L4b): иначе он считает окно
  // по имени модели и сжимает историю от чужого числа.
  deps.providerChats?.setLocalLimits((providerId, limits, env) =>
    getProvider(providerId).groupLayer === 'qwen-system-settings'
      ? writeQwenLimits({ appData: deps.appData, limits, env })
      : undefined,
  );
  return { finished: (cwd, startedAt) => testsChatFinished(deps, cwd, startedAt) };
}
