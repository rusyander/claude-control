import { existsSync, statSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectTestE2eSync } from '@agentdeck/contracts';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import type { ProviderChatService } from '../domains/provider-chat/ProviderChatService.ts';
import { e2eFolderView, e2eLinkedRoot } from '../domains/project-tests/e2e-folder.ts';
import { e2eChatLine } from '../domains/project-tests/e2e-chat.ts';
import { syncE2eIfChanged } from '../domains/project-tests/e2e-sync.ts';
import { readEnvironments } from '../domains/project-tests/library.ts';
import { readAutomation } from '../domains/project-tests/automation.ts';
import { panelHomeDir } from '../lib/brand.mjs';

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
  providerChats?: Pick<ProviderChatService, 'setWorkspaceNote'>;
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

/** CLI раздела тестов — абсолютным путём: агент вызывает его из каталога проекта. */
export function testsCliPath(): string {
  return fileURLToPath(new URL('../../../../tools/tests-cli.mjs', import.meta.url));
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
export function testsChatNote(deps: TestsChatWiringDeps, at: string): string | undefined {
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
  deps.chatRuns.setWorkspaceNote((cwd) => testsChatNote(deps, cwd));
  deps.providerChats?.setWorkspaceNote((cwd) => testsChatNote(deps, cwd));
  return { finished: (cwd, startedAt) => testsChatFinished(deps, cwd, startedAt) };
}
