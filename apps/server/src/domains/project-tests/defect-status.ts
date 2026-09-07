import type { ProjectTestDefectState, ProjectTestGroup } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { toAccess } from '../integrations/atlassian/client.ts';
import { readIssue } from '../integrations/atlassian/jira.ts';
import { readForgeIssue, toForgeAccess } from '../integrations/forge.ts';
import { readIntegrations, readToken } from '../integrations/store.ts';
import { applyDefectStates, type DefectStatePatch } from './store.ts';

/**
 * Судьба заведённых дефектов: закрыт ли уже тот баг, из-за которого кейс красный.
 *
 * Без этого связь одностороння: панель умеет завести дефект и забыть о нём.
 * Кейс остаётся проваленным ровно до следующего полного прогона, а «дефект
 * починили» узнаётся из чужого разговора. Закрытый дефект на красном кейсе —
 * это и есть список «перепроверить», ради которого дефекты вообще связывают.
 *
 * Статус кейса здесь НЕ меняется ни при каких условиях: результат ставит только
 * прогон. Трекер отвечает на вопрос «починили ли», а не «работает ли».
 */

/** Что панель поняла из адреса дефекта: где спрашивать и о чём. */
export type DefectRef =
  { kind: 'jira'; key: string } | { kind: 'forge'; number: number } | undefined;

/**
 * Опознать дефект по его адресу.
 *
 * Только по адресу — потому что он единственное, что есть у всех четырёх путей
 * заведения: `gh`, `glab`, фордж по токену и Jira возвращают панели ссылку, а
 * ключ задачи знают не все.
 */
export function defectRef(url: string): DefectRef {
  const jira = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
  if (jira?.[1]) return { kind: 'jira', key: jira[1].toUpperCase() };

  // `/-/issues/12` у GitLab и `/issues/12` у GitHub; хвост (#note_1, ?foo)
  // отбрасывается — он часть ссылки на комментарий, а не на задачу.
  const forge = url.match(/\/issues\/(\d+)(?:[/?#]|$)/);
  if (forge?.[1]) return { kind: 'forge', number: Number(forge[1]) };

  return undefined;
}

export interface DefectStatusDeps {
  store: AppStore;
  appDataDir: string;
  /** Корень проверяемого проекта: из него выводится репозиторий форджа. */
  root: string;
}

/** Кейс, который стоит перепроверить: провален, а дефект уже закрыт. */
export interface DefectRecheck {
  groupId: string;
  caseId: string;
  title: string;
  url: string;
  key?: string;
}

export interface DefectStatusResult {
  /** Сколько дефектов удалось спросить. */
  checked: number;
  closed: number;
  recheck: DefectRecheck[];
  /**
   * Почему часть дефектов осталась без ответа — по одной строке на причину.
   * Пустой список не означает «всё хорошо»: дефектов могло не быть вовсе.
   */
  skipped: string[];
}

/**
 * Спросить трекеры о каждом дефекте и записать ответ в файлы кейсов.
 *
 * Отказ одной системы не отменяет вторую: у команды бывает и Jira, и фордж, и
 * выключенная интеграция — это не ошибка запроса, а причина, названная в
 * `skipped`. Падать здесь нечему: человек нажал «обновить статусы», а не
 * «сломай мне раздел».
 */
export async function refreshDefectStates(
  deps: DefectStatusDeps,
  groups: ProjectTestGroup[],
): Promise<DefectStatusResult> {
  const patches: DefectStatePatch[] = [];
  const recheck: DefectRecheck[] = [];
  const skipped = new Set<string>();
  let closed = 0;

  const jira = lazyJira(deps, skipped);
  const forge = lazyForge(deps, skipped);

  for (const group of groups) {
    if (group.error) continue;
    for (const item of group.cases) {
      for (const defect of item.defects ?? []) {
        const ref = defectRef(defect.url);
        if (!ref) {
          skipped.add('Адрес дефекта не похож ни на задачу Jira, ни на issue форджа.');
          continue;
        }

        const answer =
          ref.kind === 'jira' ? await jira(ref.key) : await forge(ref.number, defect.url);
        if (!answer) continue;

        patches.push({
          groupId: group.id,
          caseId: item.id,
          url: defect.url,
          state: answer.state,
          stateLabel: answer.label,
          key: answer.key,
        });
        if (answer.state === 'closed') {
          closed += 1;
          // Перепроверять стоит только то, что СЕЙЧАС красное: закрытый дефект
          // на зелёном кейсе — обычная история починенного бага, и звать
          // человека к ней незачем.
          if (item.status === 'failed' || item.status === 'blocked') {
            recheck.push({
              groupId: group.id,
              caseId: item.id,
              title: item.title,
              url: defect.url,
              key: answer.key,
            });
          }
        }
      }
    }
  }

  if (patches.length > 0) applyDefectStates(deps.root, patches, new Date().toISOString());
  return { checked: patches.length, closed, recheck, skipped: [...skipped] };
}

interface Answer {
  state: ProjectTestDefectState;
  label?: string;
  key?: string;
}

/**
 * Спрашиватель Jira, собираемый по первому обращению.
 *
 * Лениво — потому что у проекта без единого дефекта Jira требовать подключение
 * не за что, а собранный заранее доступ означал бы отказ там, где спрашивать
 * было нечего.
 */
function lazyJira(
  deps: DefectStatusDeps,
  skipped: Set<string>,
): (key: string) => Promise<Answer | undefined> {
  let access: ReturnType<typeof toAccess> | undefined;
  let refused = false;

  return async (key) => {
    if (refused) return undefined;
    if (!access) {
      const settings = readIntegrations(deps.store).atlassian;
      const token = readToken(deps.appDataDir, 'atlassian');
      if (!settings.enabled || !token) {
        refused = true;
        skipped.add('Atlassian не подключён — статусы задач Jira не спрашивали.');
        return undefined;
      }
      try {
        access = toAccess(settings, token);
      } catch (error) {
        // Адрес Atlassian не заполнен: подключение есть, спрашивать некуда.
        refused = true;
        skipped.add(`Адрес Atlassian не задан: ${reasonOf(error)}`);
        return undefined;
      }
    }

    try {
      const issue = await readIssue(access, key);
      return {
        // Судим ТОЛЬКО по категории: имена статусов у каждой команды свои, и
        // «Готово» у одной означает выкат, а у другой — принятое решение не
        // чинить. Категорию считает сама Jira.
        state: issue.statusCategory === 'done' ? 'closed' : 'open',
        label: issue.status,
        key: issue.key,
      };
    } catch (error) {
      skipped.add(`Jira не ответила про ${key}: ${reasonOf(error)}`);
      return undefined;
    }
  };
}

function lazyForge(
  deps: DefectStatusDeps,
  skipped: Set<string>,
): (issueNumber: number, url: string) => Promise<Answer | undefined> {
  let access: ReturnType<typeof toForgeAccess> | undefined;
  let refused = false;

  return async (issueNumber, url) => {
    if (refused) return undefined;
    if (!access) {
      const settings = readIntegrations(deps.store).forge;
      const token = readToken(deps.appDataDir, 'forge');
      if (!settings.enabled || !token) {
        refused = true;
        skipped.add('Фордж не подключён по токену — статусы issue не спрашивали.');
        return undefined;
      }
      try {
        access = toForgeAccess(settings, token, deps.root);
      } catch (error) {
        refused = true;
        skipped.add(`Репозиторий форджа не определён: ${reasonOf(error)}`);
        return undefined;
      }
    }

    try {
      const issue = await readForgeIssue(access, issueNumber);
      return {
        state: issue.state === 'closed' ? 'closed' : 'open',
        label: issue.state === 'closed' ? 'закрыт' : 'открыт',
        key: `#${issueNumber}`,
      };
    } catch (error) {
      skipped.add(`Не удалось узнать статус ${url}: ${reasonOf(error)}`);
      return undefined;
    }
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
