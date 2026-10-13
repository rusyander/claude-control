import { array, boolean, enum as zEnum, number, object, string, type infer as Infer } from 'zod';

/**
 * Вкладка «Что нового» в «Истории изменений»: описания правок, которые пишут
 * руками (`changelog/entries/*.json`, по файлу на пуш или MR), плюс факты из
 * git. Коммиты без описания показываются по своему сообщению, поэтому лента
 * полна с первого дня.
 */

export const CHANGELOG_KINDS = [
  'added',
  'improved',
  'fixed',
  'changed',
  'removed',
  'docs',
  'internal',
] as const;
export const changelogKindSchema = zEnum(CHANGELOG_KINDS);
export type ChangelogKind = Infer<typeof changelogKindSchema>;

export const CHANGELOG_AREAS = [
  'web',
  'server',
  'mobile',
  'contracts',
  'tools',
  'tests',
  'docs',
  'other',
] as const;
export const changelogAreaSchema = zEnum(CHANGELOG_AREAS);
export type ChangelogArea = Infer<typeof changelogAreaSchema>;

/** Текст на двух языках; английский необязателен — интерфейс падает на русский. */
export const changelogTextSchema = object({
  ru: string().min(1),
  en: string().min(1).optional(),
});
export type ChangelogText = Infer<typeof changelogTextSchema>;

/** Имя файла снимка внутри `changelog/assets/<id>/` — без путей, только растровые форматы. */
export const CHANGELOG_IMAGE_FILE = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/;
export const changelogImageFileSchema = string().regex(CHANGELOG_IMAGE_FILE);

export const changelogImageRoleSchema = zEnum(['before', 'after', 'shot']);

/** Файл описания: дату и хэш не несёт — их даёт git по коммиту, где файл появился. */
export const changelogEntryFileSchema = object({
  title: changelogTextSchema,
  summary: changelogTextSchema.optional(),
  items: array(
    object({
      kind: changelogKindSchema,
      text: changelogTextSchema,
      how: changelogTextSchema.optional(),
      area: changelogTextSchema.optional(),
      images: array(changelogImageFileSchema).optional(),
    }),
  ).min(1),
  images: array(
    object({
      file: changelogImageFileSchema,
      caption: changelogTextSchema.optional(),
      role: changelogImageRoleSchema.optional(),
    }),
  ).optional(),
  links: array(
    object({ label: changelogTextSchema, url: string().regex(/^https:\/\//) }),
  ).optional(),
});
export type ChangelogEntryFile = Infer<typeof changelogEntryFileSchema>;

export const changelogCommitSchema = object({
  hash: string(),
  shortHash: string(),
  date: string(),
  subject: string(),
  /** Тело сообщения коммита без трейлеров авторства; нет, если тела нет. */
  body: string().optional(),
  files: number(),
  insertions: number(),
  deletions: number(),
});
export type ChangelogCommit = Infer<typeof changelogCommitSchema>;

const changelogCountsSchema = object({
  files: number(),
  insertions: number(),
  deletions: number(),
});

export const changelogEntrySchema = object({
  /** Описанное — имя файла без `.json`; из git — `git-<короткий хэш>`. */
  id: string(),
  /** `tree` — не выпуск, а правки рабочей копии без коммита: одни числа, описаний у них нет. */
  source: zEnum(['curated', 'git', 'tree']),
  /** `pending` — описание есть, коммита с ним ещё нет: правка в работе. */
  status: zEnum(['released', 'pending']),
  date: string(),
  /** Главный вид записи: у описанной — вид первого пункта, у автозаписи — по префиксу коммита. */
  kind: changelogKindSchema,
  title: changelogTextSchema,
  summary: changelogTextSchema.optional(),
  items: array(
    object({
      kind: changelogKindSchema,
      text: changelogTextSchema,
      how: changelogTextSchema.optional(),
      area: changelogTextSchema.optional(),
      /** Готовые адреса снимков. */
      images: array(string()),
    }),
  ),
  images: array(
    object({
      url: string(),
      caption: changelogTextSchema.optional(),
      role: changelogImageRoleSchema.optional(),
    }),
  ),
  links: array(object({ label: changelogTextSchema, url: string() })),
  /** Новые сверху. */
  commits: array(changelogCommitSchema),
  areas: array(changelogCountsSchema.extend({ area: changelogAreaSchema })),
  totals: changelogCountsSchema,
});
export type ChangelogEntry = Infer<typeof changelogEntrySchema>;

export const changelogResponseSchema = object({
  entries: array(changelogEntrySchema),
  /** false — репозитория или git нет: показаны только описания. */
  gitAvailable: boolean(),
  /** Файлы описаний, не прошедшие проверку: страница называет их, а не падает. */
  invalid: array(object({ file: string(), error: string() })),
});
export type ChangelogResponse = Infer<typeof changelogResponseSchema>;

/**
 * Обновление самой панели из её репозитория (`GET/POST /api/panel-update`).
 * Панель живёт клоном git: вышли новые коммиты на ветке, за которой следит
 * клон, — вкладка «Что нового» говорит об этом и подтягивает их одной кнопкой,
 * только перемоткой (`--ff-only`) и только при чистой рабочей копии.
 *
 * - `not-git` — панель запущена не из клона git;
 * - `no-upstream` — у ветки нет отслеживаемой ветки (или HEAD отсоединён);
 * - `current` — новых коммитов нет (свои неотправленные коммиты не мешают);
 * - `behind` — вышли новые коммиты, перемотка возможна;
 * - `diverged` — и свои коммиты, и чужие: перемоткой не обновить.
 */
export type PanelUpdateState = 'not-git' | 'no-upstream' | 'current' | 'behind' | 'diverged';

export interface PanelUpdateCommit {
  hash: string;
  /** ISO-время коммита. */
  date: string;
  subject: string;
}

export interface PanelUpdateStatus {
  state: PanelUpdateState;
  branch?: string;
  /** Отслеживаемая ветка, `origin/main`. */
  upstream?: string;
  /** Коммитов на отслеживаемой ветке, которых нет здесь. */
  behind: number;
  /** Своих коммитов, которых нет на отслеживаемой ветке. */
  ahead: number;
  /** Входящие коммиты, новые сверху (не больше 30). */
  incoming: PanelUpdateCommit[];
  /** Описания «Что нового», которые придут с обновлением: id и заголовок. */
  entries: { id: string; title: ChangelogText }[];
  /** Изменённые отслеживаемые файлы: пока список не пуст, обновление не запускается. */
  dirty: string[];
  /** Придёт новый `pnpm-lock.yaml` — после перемотки нужна установка зависимостей. */
  lockChanged: boolean;
  /** Время последнего удачного `git fetch` (ISO). */
  fetchedAt?: string;
  /** Первая строка ошибки последнего `git fetch`: сравнение идёт с прежним снимком. */
  fetchError?: string;
}

/**
 * Почему обновление не выполнено: `busy` — обновление уже идёт; `dirty` и
 * состояния — предусловие не выполнено; `pull-failed` — git отказал при
 * перемотке (текст в `detail`).
 */
export type PanelUpdateError =
  'busy' | 'dirty' | 'current' | 'not-git' | 'no-upstream' | 'diverged' | 'pull-failed';

export interface PanelUpdateResult {
  ok: boolean;
  error?: PanelUpdateError;
  /** Сырой вывод git или pnpm — показывается как есть. */
  detail?: string;
  /** HEAD до и после перемотки. */
  from?: string;
  to?: string;
  /** Зависимости переустановлены (`pnpm install`); `false` при `installError`. */
  installed?: boolean;
  /** Код обновлён, а установка зависимостей упала — что сказал pnpm. */
  installError?: string;
  /**
   * Сервер запущен dev-сторожем: правки кода сервера он подхватит сам, отложив
   * перезапуск до конца идущих ходов. `false` — перезапускать панель вручную.
   */
  watched: boolean;
  status: PanelUpdateStatus;
}
