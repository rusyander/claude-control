import type { CoreConfig } from '@agentdeck/contracts/core/config';
import type { ConfigWarning } from '../../platform/core-config/state.ts';

/**
 * Предупреждения записи настройки (этап 7, 06:108-112, 06:22): что новая настройка РАСШИРЯЕТ
 * относительно действующей — снятая маска `grantRequired`, добавленный путь чтения `readAllow`,
 * убранный пункт человека или «спрашивать» → «сам», добавленный доверенный репозиторий. Запись
 * не запрещается (её доказал человек), но расширение названо в ответе и в журнале ядра — его
 * видно, а не угадывают по разнице файлов. Сужения молчат.
 */

const NO_POINTS = { actionClasses: [], pathGlobs: [], trackerWrites: 'ask', forgeWrites: 'ask' };

function missing<T>(before: readonly T[], after: readonly T[]): T[] {
  const kept = new Set(after);
  return [...new Set(before)].filter((x) => !kept.has(x));
}

function grantRows(doc: CoreConfig): string[] {
  return (doc.grantRequired ?? []).flatMap((row) =>
    row.globs.flatMap((glob) => row.ops.map((op) => `${row.project} ${glob} [${op}]`)),
  );
}

function readRows(doc: CoreConfig): string[] {
  return Object.entries(doc.readAllow ?? {}).flatMap(([repo, paths]) =>
    paths.map((path) => `${repo} += ${path}`),
  );
}

export function configWidenings(before: CoreConfig, after: CoreConfig): ConfigWarning[] {
  const out: ConfigWarning[] = [];
  for (const row of missing(grantRows(before), grantRows(after))) {
    out.push({ section: 'grantRequired', detail: `removed ${row}` });
  }
  for (const row of missing(readRows(after), readRows(before))) {
    out.push({ section: 'readAllow', detail: `added ${row}` });
  }
  const was = before.humanPoints ?? NO_POINTS;
  const now = after.humanPoints ?? NO_POINTS;
  for (const key of ['actionClasses', 'pathGlobs'] as const) {
    for (const item of missing(was[key], now[key])) {
      out.push({ section: 'humanPoints', detail: `removed ${key} ${item}` });
    }
  }
  for (const key of ['trackerWrites', 'forgeWrites'] as const) {
    if (was[key] === 'ask' && now[key] === 'auto') {
      out.push({ section: 'humanPoints', detail: `${key} ask -> auto` });
    }
  }
  for (const repo of missing(after.trustedRepos ?? [], before.trustedRepos ?? [])) {
    out.push({ section: 'trustedRepos', detail: `added ${repo}` });
  }
  // Другой исполняемый файл CLI — другой код в каждой следующей сессии: названо, как расширение.
  // Снятый путь возвращает поиск по PATH и молчит.
  const paths = before.cliPaths ?? {};
  for (const [adapter, path] of Object.entries(after.cliPaths ?? {})) {
    if (paths[adapter] !== path) out.push({ section: 'cliPaths', detail: `${adapter} -> ${path}` });
  }
  // Сервер человека, отданный виду шага, — новые инструменты модели в каждой следующей сессии.
  const picked = (doc: CoreConfig): string[] =>
    Object.entries(doc.mcpPicks ?? {}).flatMap(([kind, ids]) =>
      (ids ?? []).map((id) => `${kind}:${id}`),
    );
  for (const row of missing(picked(after), picked(before))) {
    out.push({ section: 'mcpPicks', detail: `added ${row}` });
  }
  // Этап 12 (08e, P183): автоочередь источника входящих — записи стартуют без хода человека;
  // комментарий назад — запись в трекер и форж от задач из входящих (D18).
  const queued = (doc: CoreConfig): string[] =>
    (doc.inbox?.sources ?? []).filter((s) => s.enabled && s.autoQueue === true).map((s) => s.id);
  for (const id of missing(queued(after), queued(before))) {
    out.push({ section: 'inbox', detail: `autoQueue on ${id}` });
  }
  if (after.inbox?.commentBack === true && before.inbox?.commentBack !== true) {
    out.push({ section: 'inbox', detail: 'commentBack on' });
  }
  // Этап 12 (D29, P187): привязанный владелец Telegram открывает человеческий канал; новая привязка
  // поверх прежней — другой человек или бот, тоже расширение. Снятая (`null`) молчит.
  const owner = after.telegram?.owner ?? null;
  if (owner !== null && owner !== (before.telegram?.owner ?? null)) {
    out.push({
      section: 'telegram',
      detail: before.telegram?.owner ? 'owner rebound' : 'owner bound',
    });
  }
  // W2-D: репозиторий записей `/task` — запись из Telegram стартует в нём без выбора на доске.
  const tgRepos = (doc: CoreConfig): string[] => (doc.telegram?.repos ?? []).map((r) => r.path);
  for (const path of missing(tgRepos(after), tgRepos(before))) {
    out.push({ section: 'telegram', detail: `task repo ${path}` });
  }
  return out;
}
