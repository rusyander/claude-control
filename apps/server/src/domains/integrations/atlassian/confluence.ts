import type { ConfluencePage, ConfluenceSpace } from '@agentdeck/contracts';
import { invalidField, unreachable } from '../errors.ts';
import { call, confluenceRoot, type AtlassianAccess } from './client.ts';

/**
 * Confluence: пространства, поиск, чтение и запись страницы.
 *
 * Диалектов, как и у Jira, два, но расходятся они сильнее. У облака страницы
 * живут в API v2 (`/wiki/api/v2/pages`) и адресуются числовым `spaceId`; у своей
 * установки — в старом content-API (`/rest/api/content`) с ключом пространства.
 * Поиск в обоих идёт по CQL и различается только префиксом.
 *
 * Создание и обновление страницы — действие ЧЕЛОВЕКА кнопкой в панели, а не
 * инициатива агента: страница требований — общий документ команды, и переписать
 * её молча нельзя. Удаления нет вовсе.
 */

const CONTENT_SYSTEM = 'Confluence';

function isCloud(access: AtlassianAccess): boolean {
  return access.deployment === 'cloud';
}

interface RawV2Page {
  id: string;
  title: string;
  spaceId?: string;
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

interface RawV1Content {
  id: string;
  title: string;
  space?: { key?: string };
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

/** Абсолютный адрес страницы: `_links.webui` приходит относительным. */
function pageUrl(access: AtlassianAccess, webui: string | undefined, id: string): string {
  const root = confluenceRoot(access);
  if (!webui) return `${root}/pages/viewpage.action?pageId=${id}`;
  return webui.startsWith('http') ? webui : `${root}${webui}`;
}

export async function listSpaces(access: AtlassianAccess): Promise<ConfluenceSpace[]> {
  const root = confluenceRoot(access);
  if (isCloud(access)) {
    const page = await call<{ results?: { id: string; key: string; name: string }[] }>(access, {
      url: `${root}/api/v2/spaces?limit=100`,
      system: CONTENT_SYSTEM,
    });
    return (page.results ?? []).map((space) => ({
      id: String(space.id),
      key: space.key,
      name: space.name,
    }));
  }
  const page = await call<{ results?: { id: number | string; key: string; name: string }[] }>(
    access,
    { url: `${root}/rest/api/space?limit=100`, system: CONTENT_SYSTEM },
  );
  return (page.results ?? []).map((space) => ({
    id: String(space.id),
    key: space.key,
    name: space.name,
  }));
}

/**
 * Поиск страниц по тексту. CQL одинаков у обоих диалектов, различается только
 * корень; пространство не фильтруем — человек ищет по названию, а не по месту.
 */
export async function searchPages(
  access: AtlassianAccess,
  query: string,
  limit = 25,
): Promise<ConfluencePage[]> {
  const text = query.trim();
  if (!text) throw invalidField('q', 'нужен текст поиска');
  const cql = `type=page and text ~ "${text.replace(/"/g, '\\"')}"`;
  // Поиск по CQL живёт в старом content-API у ОБОИХ диалектов: у облака v2 его
  // не заводили вовсе. Разницу берёт на себя корень (`/wiki` у облака).
  const base = `${confluenceRoot(access)}/rest/api`;

  const page = await call<{ results?: RawV1Content[] }>(access, {
    url: `${base}/content/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(Math.max(limit, 1), 100)}&expand=version,space`,
    system: CONTENT_SYSTEM,
  });

  return (page.results ?? []).map((item) => ({
    id: String(item.id),
    title: item.title,
    spaceKey: item.space?.key ?? '',
    url: pageUrl(access, item._links?.webui, String(item.id)),
    version: item.version?.number,
  }));
}

/** Страница с телом. Тело отдаётся текстом: разметку читает человек, не браузер. */
export async function readPage(access: AtlassianAccess, id: string): Promise<ConfluencePage> {
  const root = confluenceRoot(access);
  if (isCloud(access)) {
    const page = await call<RawV2Page>(access, {
      url: `${root}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`,
      system: CONTENT_SYSTEM,
    });
    return {
      id: String(page.id),
      title: page.title,
      spaceKey: await spaceKeyById(access, page.spaceId),
      url: pageUrl(access, page._links?.webui, String(page.id)),
      version: page.version?.number,
      body: storageToText(page.body?.storage?.value ?? ''),
    };
  }

  const page = await call<RawV1Content>(access, {
    url: `${root}/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space`,
    system: CONTENT_SYSTEM,
  });
  return {
    id: String(page.id),
    title: page.title,
    spaceKey: page.space?.key ?? '',
    url: pageUrl(access, page._links?.webui, String(page.id)),
    version: page.version?.number,
    body: storageToText(page.body?.storage?.value ?? ''),
  };
}

export interface NewPage {
  spaceKey: string;
  title: string;
  /** Тело в storage-формате Confluence (XHTML), уже готовое к записи. */
  body: string;
  parentId?: string;
}

export async function createPage(access: AtlassianAccess, draft: NewPage): Promise<ConfluencePage> {
  if (!draft.spaceKey.trim()) throw invalidField('spaceKey', 'не указано пространство');
  if (!draft.title.trim()) throw invalidField('title', 'не указан заголовок страницы');
  const root = confluenceRoot(access);

  if (isCloud(access)) {
    const spaceId = await spaceIdByKey(access, draft.spaceKey.trim());
    const created = await call<RawV2Page>(access, {
      url: `${root}/api/v2/pages`,
      method: 'POST',
      system: CONTENT_SYSTEM,
      body: {
        spaceId,
        status: 'current',
        title: draft.title.trim(),
        body: { representation: 'storage', value: draft.body },
        ...(draft.parentId ? { parentId: draft.parentId } : {}),
      },
    });
    return {
      id: String(created.id),
      title: created.title,
      spaceKey: draft.spaceKey.trim(),
      url: pageUrl(access, created._links?.webui, String(created.id)),
      version: created.version?.number,
    };
  }

  const created = await call<RawV1Content>(access, {
    url: `${root}/rest/api/content`,
    method: 'POST',
    system: CONTENT_SYSTEM,
    body: {
      type: 'page',
      title: draft.title.trim(),
      space: { key: draft.spaceKey.trim() },
      body: { storage: { value: draft.body, representation: 'storage' } },
      ...(draft.parentId ? { ancestors: [{ id: draft.parentId }] } : {}),
    },
  });
  return {
    id: String(created.id),
    title: created.title,
    spaceKey: draft.spaceKey.trim(),
    url: pageUrl(access, created._links?.webui, String(created.id)),
    version: created.version?.number,
  };
}

/**
 * Обновить страницу. Номер версии обязателен в обоих диалектах и обязан быть
 * СЛЕДУЮЩИМ — читаем текущий сами, а не просим у клиента: между открытием формы
 * и нажатием кнопки страницу мог поправить кто-то ещё, и присланный из браузера
 * номер затёр бы его правку конфликтом.
 */
export async function updatePage(
  access: AtlassianAccess,
  id: string,
  patch: { title?: string; body: string },
): Promise<ConfluencePage> {
  const current = await readPage(access, id);
  const version = (current.version ?? 0) + 1;
  const title = patch.title?.trim() || current.title;
  const root = confluenceRoot(access);

  if (isCloud(access)) {
    const saved = await call<RawV2Page>(access, {
      url: `${root}/api/v2/pages/${encodeURIComponent(id)}`,
      method: 'PUT',
      system: CONTENT_SYSTEM,
      body: {
        id,
        status: 'current',
        title,
        body: { representation: 'storage', value: patch.body },
        version: { number: version, message: 'Обновлено панелью agentdeck' },
      },
    });
    return {
      id: String(saved.id),
      title: saved.title,
      spaceKey: current.spaceKey,
      url: pageUrl(access, saved._links?.webui, String(saved.id)),
      version: saved.version?.number ?? version,
    };
  }

  const saved = await call<RawV1Content>(access, {
    url: `${root}/rest/api/content/${encodeURIComponent(id)}`,
    method: 'PUT',
    system: CONTENT_SYSTEM,
    body: {
      id,
      type: 'page',
      title,
      body: { storage: { value: patch.body, representation: 'storage' } },
      version: { number: version, message: 'Обновлено панелью agentdeck' },
    },
  });
  return {
    id: String(saved.id),
    title: saved.title,
    spaceKey: current.spaceKey,
    url: pageUrl(access, saved._links?.webui, String(saved.id)),
    version: saved.version?.number ?? version,
  };
}

/** Ключ пространства → числовой id: облачный v2 адресует страницы только им. */
async function spaceIdByKey(access: AtlassianAccess, key: string): Promise<string> {
  const page = await call<{ results?: { id: string; key: string }[] }>(access, {
    url: `${confluenceRoot(access)}/api/v2/spaces?keys=${encodeURIComponent(key)}`,
    system: CONTENT_SYSTEM,
  });
  const found = (page.results ?? []).find((space) => space.key === key) ?? page.results?.[0];
  if (!found) {
    throw unreachable(`Confluence: пространства «${key}» нет или к нему нет доступа.`);
  }
  return String(found.id);
}

/** Обратный перевод — для карточки страницы: у v2 в ответе только `spaceId`. */
async function spaceKeyById(access: AtlassianAccess, spaceId?: string): Promise<string> {
  if (!spaceId) return '';
  try {
    const space = await call<{ key?: string }>(access, {
      url: `${confluenceRoot(access)}/api/v2/spaces/${encodeURIComponent(spaceId)}`,
      system: CONTENT_SYSTEM,
    });
    return space.key ?? '';
  } catch {
    // Ключ пространства — подпись на карточке, а не содержимое страницы. Если
    // на пространство нет прав, страницу всё равно надо показать.
    return '';
  }
}

/**
 * Storage-формат → читаемый текст: теги вон, сущности назад, пустые строки
 * схлопнуть. Точный разбор XHTML тут не нужен и вреден — читать это будет
 * человек в карточке и агент в задании.
 */
export function storageToText(storage: string): string {
  return storage
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Обратная сторона: текст → storage-формат, с экранированием и абзацами. */
export function textToStorage(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split(/\r?\n/)
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('');
}
