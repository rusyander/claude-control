import {
  previewInLanguage,
  type PanelActionOutcome,
  type PanelActionPreview,
  type PanelAgentPageContext,
  type PanelPendingAction,
  type PanelTextParams,
} from '@agentdeck/contracts/panel-agent';

/**
 * Агент панели на телефоне (А8): чистая часть — что сказать человеку. Разговор,
 * карточки и след — те же маршруты, что у окна панели; своего поведения у
 * телефона нет, только другой экран.
 */

/**
 * Где человек: страниц панели у телефона нет, и притворяться ими нельзя —
 * `where_am_i` вернул бы модели чужой раздел. Маршрут вне списка разделов
 * панели, заголовок прямо говорит модели, что `open_page` откроется на
 * компьютере, а не здесь. Английский: его читает модель.
 */
export const PHONE_ROUTE = 'phone';

export function phoneContext(projectPath?: string): PanelAgentPageContext {
  return {
    route: PHONE_ROUTE,
    title: 'Phone app (no panel pages here; open_page shows the page on the desktop panel)',
    ...(projectPath ? { projectPath } : {}),
  };
}

export interface DecisionTexts {
  truncated: string;
  alreadyDecided: string;
  gone: string;
  failed: (message: string) => string;
}

/**
 * Отказ решения по карточке — словами, а не статусом. Телефон с токеном решает
 * карточку наравне с окном панели (сервер принимает Bearer без Origin), поэтому
 * особого «решите на компьютере» нет: кто первый решил, того и решение, второй
 * получит «уже решено». Прочий отказ (в том числе 403) — текстом сервера.
 */
export function decisionProblem(
  error: { status?: number; code?: string; message?: string },
  texts: DecisionTexts,
): string {
  if (error.status === 409 && error.code === 'preview_truncated') return texts.truncated;
  if (error.status === 409) return texts.alreadyDecided;
  if (error.status === 404) return texts.gone;
  return texts.failed(error.message ?? '');
}

/** Решение по карточке, которое сервер отверг навсегда: повтор не поможет. */
export function isFinalRefusal(error: { status?: number; code?: string }): boolean {
  return error.status === 409 || error.status === 404;
}

export interface CardField {
  label: string;
  value: string;
  /** Длинное или многострочное значение — показываем в прокрутке, целиком. */
  long: boolean;
}

/** Текст по коду словарём телефона; без кода — русский запасной текст сервера. */
export type CardText = (
  code: string | undefined,
  params: PanelTextParams | undefined,
  fallback: string,
) => string;

/**
 * Поля карточки. Подпись и значение с кодом — словарём телефона (`text`), без
 * кода — русский запасной текст сервера; данные (путь, промпт) кода не несут и
 * не переводятся. Значение показывается ЦЕЛИКОМ — решение принимают по тому,
 * что будет выполнено, а не по началу строки. Двуязычные данные (заголовки
 * шагов) — стороной языка телефона, см. `cardPreview`.
 */
export function cardFields(
  pending: PanelPendingAction,
  text: CardText = (_code, _params, fallback) => fallback,
  language = 'ru',
): CardField[] {
  return cardPreview(pending, language).fields.map((field) => {
    const value = text(field.valueCode, field.valueParams, field.value);
    return {
      label: text(field.labelCode, field.labelParams, field.label),
      value,
      long: value.length > 160 || value.includes('\n'),
    };
  });
}

/**
 * Предпросмотр на языке телефона: у английского — английские стороны
 * двуязычных данных, когда сервер их прислал (заголовки шагов в сводке, полях и
 * диффе); иначе как пришёл — так читаются и старые записи.
 */
export function cardPreview(pending: PanelPendingAction, language: string): PanelActionPreview {
  return previewInLanguage(pending.preview, language);
}

/** Сводка карточки на языке телефона: код — словарём, подстановки — стороной языка. */
export function cardSummary(pending: PanelPendingAction, text: CardText, language: string): string {
  const preview = cardPreview(pending, language);
  return text(preview.summaryCode, preview.summaryParams, preview.summary);
}

/** Опасное действие: отказ — по умолчанию, «Выполнить» не первой кнопкой. */
export function isDanger(pending: PanelPendingAction): boolean {
  return pending.risk === 'danger';
}

/** Одобрить нельзя: предпросмотр неполный — сервер ответит 409. */
export function canApprove(pending: PanelPendingAction): boolean {
  return !pending.preview.truncated;
}

export function outcomeText(
  outcome: PanelActionOutcome,
  texts: Record<PanelActionOutcome, string>,
): string {
  return texts[outcome] ?? outcome;
}

/**
 * Надиктованное дописывается к набранному до микрофона. Отправки здесь нет:
 * агенту сообщение отдаёт человек, и оно идёт тем же путём, что набранное, —
 * через маску данных сервера.
 */
export function appendDictation(typed: string, heard: string): string {
  const text = heard.trim();
  if (!text) return typed;
  const base = typed.trimEnd();
  return base ? `${base} ${text}` : text;
}
