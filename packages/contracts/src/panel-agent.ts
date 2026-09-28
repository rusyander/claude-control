import type { AgentImage } from './agent-images';
import { PANEL_MANAGE_TEXT_PARAMS } from './panel-agent-texts-manage.ts';
import { TESTS_BLOCK_TEXT_PARAMS } from './panel-agent-texts-tests.ts';
import { GROUPS_ENTITIES_TEXT_PARAMS } from './panel-agent-texts-groups-entities.ts';
import { CHAT_TEXT_PARAMS } from './panel-agent-texts-chat.ts';
import { PROJECT_TEXT_PARAMS } from './panel-agent-texts-projects.ts';
import { CHAT_SANDBOX_AGENTS_TEXT_PARAMS } from './panel-agent-texts-chat-sandbox-agents.ts';
import { GAPS_TEXT_PARAMS } from './panel-agent-texts-gaps.ts';
/**
 * Агент панели (А0, 17.09.2026): контракт между реестром действий на сервере,
 * переходником MCP `tools/mcp/panel.mjs` и окном агента в вебе и телефоне.
 *
 * Действие описано ОДИН раз — в реестре сервера. Отсюда уходят только формы
 * обмена: что переходник показывает модели, что окно рисует в карточке
 * подтверждения, что пишется в след. Второе описание действия где-то ещё
 * разошлось бы с реестром молча.
 *
 * Сабпат без zod и без импортов из соседних сабпатов: его читают сервер без
 * сборки, Metro телефона и переходник. Схемы входа живут в реестре сервера;
 * наружу они уходят JSON Schema, собранной из той же zod-схемы.
 */

/**
 * Класс риска решает, спрашивать ли человека:
 * - `read` — выполняется сразу (списки, статусы, план запуска);
 * - `change` — карточка «что будет сделано», выполняется только по клику;
 * - `danger` — то же, но кнопка по умолчанию «Отклонить» (включить контур,
 *   применить к конфигам CLI, запустить агента, удалить).
 */
export const PANEL_ACTION_RISKS = ['read', 'change', 'danger'] as const;
export type PanelActionRisk = (typeof PANEL_ACTION_RISKS)[number];

/** Сколько действие ждёт клика человека. Дольше — отказ по таймауту. */
export const PANEL_ACTION_CONFIRM_TIMEOUT_MS = 10 * 60_000;

/**
 * Заголовок, которым переходник помечает каждый свой запрос. Маршрут решения
 * по карточке запрос с этой пометкой отклоняет: агент не подтверждает сам себя.
 */
export const PANEL_AGENT_HEADER = 'x-agentdeck-agent';

/** Префикс имени MCP-сервера переходника в конфиге CLI. */
export const PANEL_AGENT_BRIDGE_ID = 'agentdeck-panel';

/** Одно действие глазами модели и окна. `GET /api/agent/actions`. */
export interface PanelActionDescriptor {
  /** snake_case, уникально: `open_page`, `create_project`. Имя инструмента MCP. */
  name: string;
  /** Раздел панели для группировки в справке и окне: `navigation`, `projects`… */
  section: string;
  risk: PanelActionRisk;
  /** Описание для модели, английское и короткое: модель читает его каждый ход. */
  description: string;
  /** JSON Schema входа, собранная из zod-схемы реестра. */
  inputSchema: Record<string, unknown>;
}

export interface PanelActionsList {
  actions: PanelActionDescriptor[];
}

/** Куда открыть страницу у человека. `route` — путь роутера веба. */
export interface PanelPageTarget {
  route: string;
  /** Необязательный якорь: id элемента или ключ секции. */
  focus?: string;
}

/**
 * Предпросмотр для карточки подтверждения. Строки — готовые к показу;
 * `diff` — унифицированный дифф, когда действие правит файл.
 */
export interface PanelActionPreview {
  /** Запасной русский текст; окно переводит `summaryCode`, когда он есть. */
  summary: string;
  summaryCode?: PanelTextCode;
  summaryParams?: PanelTextParams;
  /**
   * Подстановки сводки для английского окна, когда в них двуязычные данные
   * (заголовок шага группы): код переводится словарём, а заголовок — данные, и
   * из `summaryParams` английская карточка читала бы русский. Нет — `summaryParams`.
   */
  summaryParamsEn?: PanelTextParams;
  fields: PanelActionPreviewField[];
  diff?: string;
  /** Тот же дифф с английскими сторонами двуязычных данных; нет — `diff`. */
  diffEn?: string;
  /**
   * Часть того, что выполнится, в карточку не поместилась (правка слишком велика
   * для диффа, тело кейсов сверх предела). Одобрить такую карточку нельзя:
   * решение `approve` отвечает 409 `preview_truncated`, окно гасит кнопку.
   */
  truncated?: boolean;
}

/**
 * Заметка карточки «Кроме файла». Домен называет КОД, русский текст собирает
 * маршрут: иначе домену пришлось бы тянуть словарь окна, а английская панель
 * читала бы русскую строку в поле с уже переведённой подписью.
 */
export interface PanelPreviewNote {
  code: PanelTextCode;
  params?: PanelTextParams;
}

/**
 * Поле карточки. `label`/`value` — русский запасной текст (сервер второй язык не
 * держит); коды — то, что окно переводит своим словарём. Значение без кода —
 * данные (путь, адрес, промпт) и показывается как есть.
 */
export interface PanelActionPreviewField {
  label: string;
  value: string;
  /**
   * Значение-данные для английского окна, когда у данных два языка (заголовки
   * шагов сценария и группы). Нет — `value`: старые записи и одноязычные данные.
   */
  valueEn?: string;
  labelCode?: PanelTextCode;
  labelParams?: PanelTextParams;
  valueCode?: PanelTextCode;
  valueParams?: PanelTextParams;
}

/** Окно на английском: `en`, `en-US`… Остальные языки читают русский запасной текст. */
const isEnglishWindow = (language: string): boolean =>
  language.toLowerCase().split('-')[0] === 'en';

/**
 * Предпросмотр на языке окна: английские варианты данных (`summaryParamsEn`,
 * `valueEn`, `diffEn`) подставляются на место основных у английского окна и
 * там, где сервер их прислал; иначе предпросмотр как есть — так читаются и
 * записи, сделанные до вариантов. Коды дальше переводит словарь клиента.
 */
export function previewInLanguage(
  preview: PanelActionPreview,
  language: string,
): PanelActionPreview {
  if (!isEnglishWindow(language)) return preview;
  return {
    ...preview,
    ...(preview.summaryParamsEn ? { summaryParams: preview.summaryParamsEn } : {}),
    ...(preview.diffEn !== undefined ? { diff: preview.diffEn } : {}),
    fields: preview.fields.map((field) =>
      field.valueEn !== undefined ? { ...field, value: field.valueEn } : field,
    ),
  };
}

/**
 * Тексты карточки и следа кодом — по образцу `server-messages.ts`: код → имена
 * подстановок. Русский текст сервера остаётся запасным (старые записи следа,
 * клиент без словаря), окно и телефон переводят код. Тест словарей сверяет,
 * что у каждого кода есть ru и en ровно с этими подстановками.
 */
export const panelTextParams = {
  // След: строка чтения и название правки.
  'journal-where-am-i': [],
  'journal-list-sections': [],
  'journal-open-page': [],
  'journal-list-projects': [],
  'journal-create-project': [],
  'journal-list-chats': [],
  'journal-list-active-runs': [],
  'journal-start-chat': [],
  'journal-list-test-groups': [],
  'journal-list-cases': [],
  'journal-coverage': [],
  'journal-last-run': [],
  'journal-draft-cases': [],
  'journal-run-tests': [],
  'journal-list-contours': [],
  'journal-contour-status': [],
  'journal-probe-contour': [],
  'journal-save-contour-draft': [],
  'journal-enable-contour': [],
  'journal-list-rules': [],
  'journal-list-skills': [],
  'journal-list-hooks': [],
  'journal-list-mcp': [],
  'journal-list-permissions': [],
  'journal-save-rule': [],
  'journal-toggle-rule': [],
  'journal-delete-rule': [],
  'journal-save-skill': [],
  'journal-delete-skill': [],
  'journal-add-permission': [],
  'journal-remove-permission': [],
  'journal-save-mcp': [],
  'journal-delete-mcp': [],
  'journal-invalid-input': [],
  // След: факты исхода после названия.
  'fact-diff': [],
  'fact-truncated': [],
  'fact-stale': [],
  // Сводка карточки.
  'summary-create-project': ['title'],
  'summary-start-chat': ['project'],
  'summary-start-chat-home': [],
  'summary-draft-cases': ['count'],
  'summary-run-tests-generate': [],
  'summary-run-tests-run': ['count'],
  'summary-contour-draft-save': ['title'],
  'summary-contour-draft-update': ['title'],
  'summary-enable-contour': ['title'],
  'summary-rule-add': ['title'],
  'summary-rule-edit': ['title'],
  'summary-rule-enable': ['title'],
  'summary-rule-disable': ['title'],
  'summary-rule-delete': ['title'],
  'summary-skill-create': ['name'],
  'summary-skill-edit': ['name'],
  'summary-skill-delete': ['name'],
  'summary-permission-add': ['decision', 'pattern'],
  'summary-permission-remove': ['rule'],
  'summary-permission-add-allow': ['pattern'],
  'summary-permission-add-deny': ['pattern'],
  'summary-permission-add-ask': ['pattern'],
  'summary-mcp-add': ['name'],
  'summary-mcp-edit': ['name'],
  'summary-mcp-delete': ['name'],
  // Подписи полей.
  'label-directory': [],
  'label-title': [],
  'label-e2e-folder': [],
  'value-e2e-onboard-create': ['dir'],
  'value-e2e-onboard-create-plain': ['dir'],
  'value-e2e-onboard-sync': ['dir', 'count'],
  'value-e2e-onboard-keep': ['dir'],
  'value-e2e-onboard-maybe': [],
  'label-project': [],
  'label-provider': [],
  'label-model': [],
  'label-contour': [],
  'label-file-edits': [],
  'label-first-message': [],
  'label-chat-mode': [],
  'label-topic': [],
  'label-case-add': ['target'],
  'label-case-update': ['target'],
  'label-draft': [],
  'label-hidden': [],
  'label-mode': [],
  'label-selected-cases': [],
  'label-group': [],
  'label-environment': [],
  'label-scope': [],
  'label-warning': [],
  'label-id': [],
  'label-address': [],
  'label-driver': [],
  'label-consumers': [],
  'label-key': [],
  'label-enabling': [],
  'label-active-now': [],
  'label-last-probe': [],
  'label-what-happens': [],
  'label-file': [],
  'label-new-file': [],
  'label-file-shape': [],
  'label-besides-file': [],
  'label-rule-title': [],
  'label-skill-name': [],
  'label-transport': [],
  'label-command': [],
  'label-secrets-by-you': [],
  // Значения полей, которые пишет сама панель (не данные).
  'value-model-default': [],
  'value-edits-allowed': [],
  'value-edits-denied': [],
  'value-no-project': [],
  'value-mode-message': [],
  'value-mode-deck': [],
  'value-mode-image': [],
  'value-cases-hidden': ['count'],
  'value-mode-generate': [],
  'value-mode-run': [],
  'value-group-all': [],
  'value-provider-other': ['provider', 'active'],
  'value-contour-refuses': ['reason'],
  'value-run-already': ['id'],
  'value-consumers-default': [],
  'value-key-kept': [],
  'value-key-by-you': [],
  'value-enabling-separate': [],
  'value-active-none': [],
  'value-key-accepted': [],
  'value-key-state': ['state'],
  'value-probe-never': [],
  'value-happens-rollback': ['previous'],
  'value-happens-probe': [],
  'value-file-shape': ['path'],
  // Заметки карточки «Кроме файла»: значение пишет сама панель, поэтому оно
  // едет кодом, а не русской строкой из домена (английское окно иначе читало
  // бы русский текст в поле, подпись которого уже переведена).
  'note-rule-group-off': [],
  'note-skill-folder-delete': ['dir'],
  'note-skill-folder-files': ['files'],
  'note-permission-mark-only': [],
  'note-mcp-oauth-delete': [],
  'note-mcp-rename': ['from', 'to'],
  'note-hook-group-off': [],
  'note-hook-local-file': [],
  'note-hook-delete-disabled': [],
  'note-copy-in-history': [],
  'note-entity-group-off': [],
  'note-folder-move': ['from', 'to'],
  'journal-list-groups': [],
  'journal-save-group': [],
  'summary-group-create': ['name'],
  'summary-group-edit': ['name'],
  'label-members': [],
  'journal-toggle-group': [],
  'summary-group-enable': ['name'],
  'summary-group-disable': ['name'],
  'label-env-keys': [],
  'journal-delete-group': [],
  'summary-group-delete': ['name'],
  'label-group-delete-env': [],
  'label-group-delete-back-on': [],
  'journal-read-group': [],
  'journal-draft-group': [],
  'summary-group-draft': ['name'],
  'journal-copy-group': [],
  'summary-group-copy': ['name', 'copy'],
  'label-group-copy-effect': [],
  'value-group-copy-effect': [],
  'journal-add-group-step': [],
  'summary-group-step-add': ['name', 'title'],
  'journal-move-group-step': [],
  'summary-group-step-move': ['name', 'title'],
  'journal-set-group-knobs': [],
  'summary-group-knobs': ['name'],
  'label-group-steps': [],
  'journal-draft-scenario': [],
  'summary-scenario-draft': ['name'],
  'label-scenario-steps': [],
  'label-group-step-prompt': [],
  'label-group-knobs': [],
  'journal-get-settings': [],
  'journal-update-settings': [],
  'summary-settings-update': ['keys'],
  'journal-switch-provider': [],
  'summary-provider-switch': ['from', 'to'],
  'journal-list-endpoints': [],
  'journal-save-endpoint': [],
  'summary-endpoint-create': ['name'],
  'summary-endpoint-edit': ['name'],
  'journal-probe-endpoint': [],
  'journal-apply-endpoint': [],
  'summary-endpoint-apply': ['name', 'provider'],
  'journal-delete-endpoint': [],
  'summary-endpoint-delete': ['name'],
  'journal-get-dlp': [],
  'journal-save-dlp-rules': [],
  'summary-dlp-rules': ['count'],
  'journal-toggle-dlp-proxy': [],
  'summary-dlp-start': [],
  'summary-dlp-stop': [],
  'journal-list-integrations': [],
  'journal-save-integration': [],
  'summary-integration-save': ['id'],
  'journal-check-integration': [],
  'summary-integration-check': ['id'],
  'value-happens-integration-check': [],
  'value-happens-webhook-test': [],
  'journal-forget-integration': [],
  'summary-integration-forget': ['id'],
  'journal-save-hook': [],
  'summary-hook-add': ['event'],
  'summary-hook-edit': ['event'],
  'label-matchers': [],
  'journal-toggle-hook': [],
  'summary-hook-enable': ['event'],
  'summary-hook-disable': ['event'],
  'journal-delete-hook': [],
  'summary-hook-delete': ['event'],
  'journal-list-env': [],
  'journal-set-env': [],
  'summary-env-set': ['key', 'source'],
  'journal-delete-env': [],
  'summary-env-delete': ['key', 'source'],
  'journal-read-claude-md': [],
  'journal-save-claude-md': [],
  'summary-claude-md-save': [],
  'journal-list-scripts': [],
  'journal-read-script': [],
  'journal-save-script': [],
  'summary-script-create': ['id'],
  'summary-script-edit': ['id'],
  'journal-delete-script': [],
  'summary-script-delete': ['id'],
  'journal-list-commands': [],
  'journal-toggle-skill': [],
  'journal-toggle-mcp': [],
  'journal-toggle-permission': [],
  'summary-entity-enable': ['name'],
  'summary-entity-disable': ['name'],
  'journal-search-help': [],
  'journal-read-help-topic': [],
  'journal-list-help-topics': [],
  'journal-overview': [],
  'journal-search-panel': [],
  'journal-analytics-summary': [],
  'journal-compare-providers': [],
  'journal-env-passport': [],
  'journal-list-plugins': [],
  'journal-list-available-plugins': [],
  'journal-install-plugin': [],
  'summary-plugin-install': ['id'],
  'journal-uninstall-plugin': [],
  'summary-plugin-uninstall': ['id'],
  'journal-toggle-plugin': [],
  'summary-plugin-enable': ['id'],
  'summary-plugin-disable': ['id'],
  'journal-update-plugin': [],
  'summary-plugin-update': ['id'],
  'label-version': [],
  'label-plugin-scope': [],
  'journal-add-marketplace': [],
  'summary-marketplace-add': ['source'],
  'journal-remove-marketplace': [],
  'summary-marketplace-remove': ['name'],
  'journal-list-history': [],
  'journal-history-diff': [],
  'journal-revert-hunk': [],
  'summary-revert-hunk': ['file', 'hunk'],
  'label-backup': [],
  'journal-list-backups': [],
  'journal-restore-backup': [],
  'summary-restore-backup': ['target'],
  'label-created': [],
  'journal-delete-project': [],
  'summary-delete-project': ['name'],
  'journal-project-git-status': [],
  'journal-list-worktrees': [],
  'journal-list-test-runs': [],
  'journal-read-test-run': [],
  'journal-lint-tests': [],
  'journal-stop-tests': [],
  'summary-stop-tests': ['mode'],
  'journal-delete-test-case': [],
  'summary-delete-test-case': ['title'],
  'value-mode-explore': [],
  'summary-run-tests-explore': [],
  'journal-save-test-case': [],
  'summary-save-test-case-create': ['title'],
  'summary-save-test-case-update': ['title'],
  'journal-save-test-group': [],
  'summary-save-test-group-create': ['title'],
  'summary-save-test-group-update': ['title'],
  'journal-delete-test-group': [],
  'summary-delete-test-group': ['title', 'count'],
  'journal-reject-draft': [],
  'summary-reject-draft': ['count'],
  ...TESTS_BLOCK_TEXT_PARAMS,
  ...PANEL_MANAGE_TEXT_PARAMS,
  ...GROUPS_ENTITIES_TEXT_PARAMS,
  ...CHAT_TEXT_PARAMS,
  ...PROJECT_TEXT_PARAMS,
  ...CHAT_SANDBOX_AGENTS_TEXT_PARAMS,
  ...GAPS_TEXT_PARAMS,
} as const satisfies Record<string, readonly string[]>;

export type PanelTextCode = keyof typeof panelTextParams;
export type PanelTextParams = Record<string, string | number>;

export const panelTextCodes = Object.keys(panelTextParams) as PanelTextCode[];

/**
 * Коды с подстановкой `count` — только у них бывают формы множественного числа
 * («1 кейс», «3 кейса», «5 кейсов»). Словари окна кладут формы ключами i18next
 * `<код>_one|_few|_many|_other`, сервер — объектом форм под `Intl.PluralRules`.
 */
export type PanelTextCountCode = {
  [C in PanelTextCode]: 'count' extends (typeof panelTextParams)[C][number] ? C : never;
}[PanelTextCode];

export const PANEL_PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PanelPluralForm = (typeof PANEL_PLURAL_FORMS)[number];

export const panelTextCountCodes = panelTextCodes.filter((code) =>
  (panelTextParams[code] as readonly string[]).includes('count'),
) as PanelTextCountCode[];

/** Формы, которых требуют правила языка (`Intl.PluralRules`), без `zero`/`two` у ru и en. */
export function requiredPluralForms(language: string): PanelPluralForm[] {
  const rules = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  return PANEL_PLURAL_FORMS.filter((form) => rules.includes(form));
}

export function isPanelTextCode(value: unknown): value is PanelTextCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(panelTextParams, value);
}

/** Текст по шаблону `{{имя}}`: недостающая подстановка — пустая строка. */
export function formatPanelText(template: string, params: PanelTextParams = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    params[name] === undefined ? '' : String(params[name]),
  );
}

/** Тело `POST /api/agent/actions/:name`. */
export interface PanelActionCall {
  input: unknown;
  /** Разговор агента — чтобы окно показало карточку в нужном диалоге. */
  conversationId?: string;
}

/**
 * Итог вызова. Никогда не HTTP-ошибка для отказа человека или таймаута:
 * переходник получает ответ 200 и отдаёт модели обычное предложение.
 * - `done` — выполнено; `result` — ответ маршрута как есть;
 * - `rejected` / `timeout` — человек отклонил или не ответил;
 * - `invalid` — вход не прошёл схему; `unknown` — нет такого действия;
 * - `failed` — маршрут ответил ошибкой, `status` и `message` — его;
 * - `needs-secret` — дальше нужен ключ, поле открыто у человека, агенту
 *   вернётся только «сохранён / отклонён»;
 * - `cancelled` — переходник оборвал запрос, пока карточка ждала клика (агент
 *   остановлен, окно закрыто): карточка снимается, действие не выполняется.
 *   Модели этот исход не доходит — отвечать уже некому; он виден в следе и окне.
 */
export const PANEL_ACTION_OUTCOMES = [
  'done',
  'rejected',
  'timeout',
  'invalid',
  'unknown',
  'failed',
  'needs-secret',
  'cancelled',
] as const;
export type PanelActionOutcome = (typeof PANEL_ACTION_OUTCOMES)[number];

/**
 * Стабильные коды текста исхода — по образцу `server-messages.ts`: `message`
 * остаётся запасным текстом (и предложением для модели), окно переводит код
 * своим словарём `i18n/panel-agent`.
 * - `stale_preview` — человек одобрил карточку, но цель (файл, запись контура,
 *   группа кейсов, настройки) изменилась после показа: не выполнено ничего,
 *   агент должен запросить действие заново, чтобы человек увидел новую карточку.
 */
export const PANEL_ACTION_MESSAGE_CODES = ['stale_preview'] as const;
export type PanelActionMessageCode = (typeof PANEL_ACTION_MESSAGE_CODES)[number];

export function isPanelActionMessageCode(value: unknown): value is PanelActionMessageCode {
  return (PANEL_ACTION_MESSAGE_CODES as readonly unknown[]).includes(value);
}

export interface PanelActionResult {
  outcome: PanelActionOutcome;
  result?: unknown;
  status?: number;
  message?: string;
  messageCode?: PanelActionMessageCode;
  /** Страница, которую панель открыла у человека после действия. */
  page?: PanelPageTarget;
}

/** Ожидающее подтверждение. `GET /api/agent/pending`. */
export interface PanelPendingAction {
  id: string;
  name: string;
  risk: Exclude<PanelActionRisk, 'read'>;
  conversationId?: string;
  preview: PanelActionPreview;
  createdAt: string;
  expiresAt: string;
}

/** Тело `POST /api/agent/pending/:id`. Повторное решение — 409. */
export interface PanelPendingDecision {
  decision: 'approve' | 'reject';
}

/** Строка следа `<appData>/agent-actions.jsonl`, `GET /api/agent/journal`. */
export interface PanelActionJournalEntry {
  at: string;
  name: string;
  risk: PanelActionRisk;
  outcome: PanelActionOutcome;
  /**
   * `auto` — чтение без вопроса (и отказ до карточки: неверный вход); `human` —
   * клик в карточке; `timeout` — клика не было; `client` — переходник ушёл, не
   * дождавшись решения.
   */
  decidedBy: 'auto' | 'human' | 'timeout' | 'client';
  conversationId?: string;
  /** HTTP-статус маршрута, когда действие до него дошло (`done`/`failed`). */
  status?: number;
  /** Код причины исхода, когда он есть (`stale_preview`). */
  messageCode?: PanelActionMessageCode;
  /** Короткая сводка из предпросмотра; вход целиком не пишется — в нём бывают данные. */
  summary: string;
  /** Название (или строка чтения) кодом — окно переводит; `summary` запасной. */
  summaryCode?: PanelTextCode;
  /** Факты исхода кодами, через запятую после названия. */
  summaryFacts?: PanelTextCode[];
}

/** Где человек сейчас: уходит агенту первой строкой контекста. */
export interface PanelAgentPageContext {
  route: string;
  title?: string;
  projectPath?: string;
}

/**
 * Кадры `/api/events` агента. Лежат рядом с `changed` в том же потоке:
 * отдельный поток означал бы вторую переподписку и второй пропуск кадров.
 */
export type PanelAgentEvent =
  | { type: 'agent-open-page'; page: PanelPageTarget; conversationId?: string }
  | { type: 'agent-pending'; pending: PanelPendingAction }
  | {
      type: 'agent-decided';
      id: string;
      outcome: PanelActionOutcome;
      messageCode?: PanelActionMessageCode;
      /** Раздел действия: окно перечитывает данные этого раздела после правки. */
      section?: string;
    };

// --- Прогон агента (А2) ------------------------------------------------------

/**
 * Сколько CLI ждёт ответа инструмента MCP (`MCP_TOOL_TIMEOUT` в окружении
 * прогона). Больше ожидания карточки с запасом: иначе CLI бросил бы вызов
 * раньше, чем человек успел нажать, и карточка исполнилась бы в пустоту.
 */
export const PANEL_AGENT_MCP_TOOL_TIMEOUT_MS = PANEL_ACTION_CONFIRM_TIMEOUT_MS + 60_000;

/** Потолок одного хода агента: ожидание карточки плюс время на работу. */
export const PANEL_AGENT_RUN_TIMEOUT_MS = PANEL_ACTION_CONFIRM_TIMEOUT_MS + 5 * 60_000;

/** Идентификатор разговора: уходит в имя файла и в аргументы переходника. */
export const PANEL_AGENT_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface PanelAgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Тело `POST /api/agent/run`. Последняя реплика — человека. */
export interface PanelAgentRunRequest {
  messages: PanelAgentMessage[];
  /** Не задан — сервер заводит новый и называет его в кадре `start`. */
  conversationId?: string;
  context: PanelAgentPageContext;
  /**
   * Картинки последней реплики — в самом запросе, блоками `image`: файловой
   * системы у агента нет. Реплика называет их строкой `AGENT_IMAGES_MARKER`.
   */
  images?: AgentImage[];
}

/**
 * Отказ ДО запуска — JSON с HTTP-статусом, не поток:
 * - `invalid_body` (400) — тело не прошло схему;
 * - `busy` (409) — в этом разговоре ход уже идёт;
 * - `provider_unsupported` (409) — активный CLI не Claude: переходник для
 *   чужих CLI и серверный цикл инструментов для API-режима ещё не построены;
 * - `cli_not_found` (409) — `claude` не найден в PATH (режим API без CLI —
 *   тоже сюда: без CLI инструментов MCP у агента нет);
 * - `endpoint_unsupported` (409) — ассистенту выбран свой эндпоинт, не контур:
 *   его токен пришлось бы отдать процессу CLI;
 * - `contour_unreachable` (409) — ассистент идёт через контур, а шлюз не поднят
 *   или ключа нет: молча уйти в облако вендора нельзя;
 * - `data_mask_broken` (409) — файл правил защиты данных не читается: реплики
 *   человека не замаскировать, и ход без маски не запускается.
 */
export const PANEL_AGENT_RUN_REFUSALS = [
  'invalid_body',
  'busy',
  'provider_unsupported',
  'cli_not_found',
  'endpoint_unsupported',
  'contour_unreachable',
  'data_mask_broken',
  /** Разговор продолжили в другой вкладке: история окна отстала от файла. */
  'conversation_stale',
  /** Разговор удалили в другой вкладке, а окно пишет в него со своей историей. */
  'conversation_deleted',
] as const;
export type PanelAgentRunRefusalCode = (typeof PANEL_AGENT_RUN_REFUSALS)[number];

export interface PanelAgentRunRefusal {
  error: PanelAgentRunRefusalCode;
  message: string;
}

/**
 * Кадры потока `POST /api/agent/run` (SSE, `data: <json>`). Вход инструмента
 * в кадр не кладётся: окно показывает карточку из `agent-pending`, а данные
 * человека в потоке не нужны.
 */
export type PanelAgentRunEvent =
  | {
      kind: 'start';
      conversationId: string;
      providerId: string;
      /** Ход идёт через контур — его идентификатор. */
      contourId?: string;
    }
  | { kind: 'text'; text: string }
  /** `name` — имя действия реестра, без префикса MCP. */
  | { kind: 'tool'; name: string }
  | { kind: 'tool-result'; name: string; isError: boolean }
  | { kind: 'done'; reply: string }
  | { kind: 'error'; message: string };

/** Файл разговора `<appData>/panel-agent/<id>.json`. */
export interface PanelAgentConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  context: PanelAgentPageContext;
  /**
   * `interrupted` — ответ, запечатанный панелью за оборванный ход: сказанное и
   * выполненное до обрыва плюс пометка «не дописан». Модель ответа не закончила.
   */
  messages: Array<PanelAgentMessage & { at: string; interrupted?: true; seal?: PanelAgentSeal }>;
  /**
   * Идущий ход: что уже сказано и какие действия выполнены. Пишется по ходу,
   * чтобы перезапуск панели посреди хода не стёр сделанное; `boot` — метка
   * процесса панели, ход с чужой меткой умер вместе с прежним процессом.
   */
  openTurn?: PanelAgentOpenTurn;
}

export interface PanelAgentOpenTurn {
  boot: string;
  startedAt: string;
  texts: string[];
  /**
   * Имя действия, у неудачного — с пометкой ` (failed)` (её читает модель, язык
   * английский). Без ответа переходника: он может нести данные.
   */
  actions: string[];
}

/** Почему ход запечатан: перезапуск панели, остановка, потолок времени, сбой CLI. */
export type PanelAgentSealReason = 'restart' | 'stopped' | 'timeout' | 'failed';

/**
 * Код запечатанного ответа. Текст реплики уходит модели следующим ходом и потому
 * английский (D-E); пометку «ответ не дописан» окно рисует человеку своим языком
 * по этому коду (`sealNote` в `panel-agent-feed.ts`).
 */
export interface PanelAgentSeal {
  reason: PanelAgentSealReason;
  /** Действия хода, как в `PanelAgentOpenTurn.actions`. */
  actions: string[];
  /** Сырая причина сбоя (текст CLI) — только у `failed`, не переводится. */
  detail?: string;
}

/** Строка списка разговоров `GET /api/agent/conversations`. */
export interface PanelAgentConversationSummary {
  id: string;
  updatedAt: string;
  /** Первая реплика человека, обрезанная. */
  title: string;
  messages: number;
}
