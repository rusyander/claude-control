import type { IntegrationPublishResult } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { readGroups } from '../project-tests/store.ts';
import { readRun } from '../project-tests/runs-store.ts';
import { runToMarkdown } from '../project-tests/export-run.ts';
import { IntegrationError, invalidField } from './errors.ts';
import { linkForCwd } from './links.ts';
import { readConfluenceToken, readIntegrations, requireConnected } from './store.ts';
import { toAccess } from './atlassian/client.ts';
import { commentIssue } from './atlassian/jira.ts';
import { createPage, readPage } from './atlassian/confluence.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Отчёт по прогону — наружу, туда, где его прочтут без панели.
 *
 * Отчёт НЕ пишется заново: это тот же документ, что уходит файлом
 * (`project-tests/export-run.ts`), только переложенный в чужой формат. Иначе
 * через месяц md и опубликованная страница разошлись бы содержанием, и «какой
 * из них настоящий» стало бы вопросом.
 *
 * Куда именно — панель не выбирает и не угадывает: адрес берётся из привязки,
 * которую человек сделал руками (`links.ts`). Нет привязки — честный отказ с
 * именем того, чего не хватает, а не «опубликовано куда-то».
 */

export type PublishTarget = 'confluence' | 'jira';

export interface PublishDeps {
  store: AppStore;
  /** Каталог данных панели: там лежит зашифрованное хранилище токенов. */
  appDataDir: string;
}

export interface PublishRequest {
  /** Каталог проверяемого проекта — по нему находится привязка. */
  path: string;
  /** Прогон: имя файла записи или её собственный id. */
  runId: string;
  target: PublishTarget;
  /** Группа тестов: её привязка сильнее проектной. */
  groupId?: string;
}

export async function publishRun(
  deps: PublishDeps,
  request: PublishRequest,
): Promise<IntegrationPublishResult> {
  const root = String(request.path ?? '').trim();
  if (!root)
    throw invalidField('path', 'не указан каталог проекта', 'request-project-dir-missing', {
      field: 'path',
    });
  const runId = String(request.runId ?? '').trim();
  if (!runId) throw invalidField('id', 'не указан прогон', 'request-run-missing', { field: 'id' });
  if (request.target !== 'confluence' && request.target !== 'jira') {
    throw invalidField(
      'target',
      'публиковать можно в confluence или в jira',
      'request-publish-target',
      { field: 'target' },
    );
  }

  const run = readRun(root, runId);
  if (!run) {
    throw coded(
      new IntegrationError('integration_not_found', `Прогон «${runId}» не найден.`),
      'publish-run-not-found',
      { runId },
    );
  }

  const found = linkForCwd(deps.store, root, request.groupId);
  if (!found) {
    throw new IntegrationError(
      'integration_not_found',
      'К проекту ничего не привязано: укажите задачу Jira или страницу Confluence в настройках проекта.',
    );
  }

  const token = requireConnected(deps.store, deps.appDataDir, 'atlassian', 'Atlassian');
  // Второй ключ — для публикации в Confluence: на своей установке он свой (см.
  // `atlassian/client.ts`), и без него отчёт уезжал бы в 401 на рабочей Jira.
  const access = toAccess(
    readIntegrations(deps.store).atlassian,
    token,
    readConfluenceToken(deps.appDataDir) ?? '',
  );
  // Ошибки в файлах групп молчаливо пропускаем: заголовки кейсов — украшение
  // отчёта, а сорванный из-за битой группы отчёт по успешному прогону — нет.
  const markdown = runToMarkdown(
    run,
    readGroups(root).filter((group) => !group.error),
  );

  if (request.target === 'jira') {
    const key = found.link.jiraIssueKey;
    if (!key) {
      throw new IntegrationError(
        'integration_not_found',
        'К проекту не привязана задача Jira — привяжите её и повторите.',
      );
    }
    await commentIssue(access, key, commentText(markdown));
    // `created: false` — комментарий дописан в существующую задачу, ничего
    // нового не появилось; кнопка в панели говорит именно это.
    return { url: `${access.baseUrl}/browse/${key}`, created: false };
  }

  const parentId = found.link.confluencePageId;
  if (!parentId) {
    throw new IntegrationError(
      'integration_not_found',
      'К проекту не привязана страница Confluence — привяжите её и повторите.',
    );
  }

  /*
   * Отчёт кладётся ДОЧЕРНЕЙ страницей, а привязанная не трогается вовсе.
   *
   * Привязывают обычно страницу требований — общий документ команды. Перезапись
   * её отчётом прогона стёрла бы чужую работу одним нажатием, и вернуть её мог
   * бы только тот, кто знает про историю версий Confluence. Дочерняя страница
   * сохраняет и требования, и связь между ними.
   */
  const parent = await readPage(access, parentId);
  if (!parent.spaceKey) {
    throw new IntegrationError(
      'integration_unreachable',
      'Confluence не сказал, в каком пространстве лежит привязанная страница, — публиковать некуда.',
    );
  }

  const created = await createPage(access, {
    spaceKey: parent.spaceKey,
    title: pageTitle(run.startedAt, parent.title),
    body: markdownToStorage(markdown),
    parentId,
  });
  return { url: created.url, created: true };
}

/**
 * Заголовок страницы отчёта. Он обязан быть УНИКАЛЬНЫМ в пространстве — иначе
 * Confluence откажет 400 на второй публикации, — поэтому в него входит время
 * начала прогона: два прогона в одну секунду с одной машины не бывают.
 */
function pageTitle(startedAt: string, parentTitle: string): string {
  const stamp = startedAt
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .replace(/Z$/, '');
  return `Прогон тестов ${stamp} — ${parentTitle}`.slice(0, 250);
}

/**
 * Тело комментария Jira: всё до таблицы проходов.
 *
 * Комментарий — это оповещение, а не документ: таблицу на девять колонок в нём
 * не читает никто, а в ADF облака она и вовсе разворачивается в простыню
 * абзацев. Обстоятельства прогона, итог и список упавшего — ровно то, ради чего
 * комментарий открывают; полный отчёт лежит файлом и страницей.
 */
export function commentText(markdown: string): string {
  const at = markdown.indexOf('\n## Проходы');
  return (at === -1 ? markdown : markdown.slice(0, at)).trim();
}

/** Экранирование для storage-формата: он XHTML, и `&` в заметке ломает страницу. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Внутристрочная разметка: жирный из `**…**`. Больше в отчёте ничего нет. */
function inline(value: string): string {
  return escapeXml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Ячейки строки таблицы markdown: крайние палки отбрасываются. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isSeparator(line: string): boolean {
  return /^\s*\|(\s*-{3,}\s*\|)+\s*$/.test(line);
}

/**
 * Markdown отчёта → storage-формат Confluence.
 *
 * Полноценный markdown тут не нужен и был бы враньём про свои возможности:
 * разбирается ровно то, что порождает `runToMarkdown`, — заголовки, маркированный
 * список, одна таблица и жирный текст. Чужой markdown сюда не попадает.
 *
 * Confluence умеет принимать и `representation: 'wiki'`, но только у части
 * установок и с отдельным преобразованием на их стороне; storage принимают все.
 */
export function markdownToStorage(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let list: string[] = [];

  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushList();
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      list.push(bullet[1]!);
      continue;
    }

    if (trimmed.startsWith('|')) {
      flushList();
      const rows: string[][] = [];
      let head: string[] | undefined;
      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        const current = lines[index]!;
        if (isSeparator(current)) {
          head = rows.pop();
        } else {
          rows.push(cells(current));
        }
        index += 1;
      }
      index -= 1;
      const header = head
        ? `<tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>`
        : '';
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><tbody>${header}${body}</tbody></table>`);
      continue;
    }

    flushList();
    out.push(`<p>${inline(trimmed)}</p>`);
  }

  flushList();
  return out.join('');
}
