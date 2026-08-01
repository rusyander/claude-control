/**
 * Раздел «Хуки» у НЕ-Claude провайдера (OPENCODE-3).
 *
 * У Claude хуки — свой богатый раздел (`domains/hooks.ts`, маршруты `/api/hooks`,
 * события `PreToolUse`/`PostToolUse`, матчеры, shell-команды). Он НЕ МЕНЯЕТСЯ:
 * модель у OpenCode принципиально другая, и мешать их в одном домене нельзя.
 *
 * У раздела ДВЕ ФОРМЫ, и выбирает их формат хранилища (`hooksShapeOf`):
 *
 *  - `opencode-events` — ключ `experimental.hook` в `opencode.json` (глобальном и
 *    проектном): ровно два задокументированных события (`file_edited`,
 *    `session_completed`), действия-argv. Разбор — `lib/opencode-hook.ts`.
 *    С 25 июля 2026 ТОЛЬКО ЧТЕНИЕ: ключ исчез из документации и схемы OpenCode
 *    (`writeDisabledReason` в каталоге), писать его — гадание;
 *  - `event-rules` — плоский список правил «событие + матчер + команда +
 *    таймаут»: у Qwen это ключ корня `hooks` в `settings.json`
 *    (`lib/qwen-hook.ts`, таймаут в миллисекундах), у Kimi — массив таблиц
 *    `[[hooks]]` в `config.toml` (`lib/kimi-hook.ts`, таймаут в секундах).
 *    Событие, форму которого панель не поняла, сохраняется целиком и не
 *    редактируется (у Kimi это переводит в чтение весь раздел: плоский массив
 *    нельзя переписать частично, не потеряв чужое).
 *
 * ЗАЩИТЫ, как во всех провайдер-разделах: валидация черновика ДО записи (400),
 * fail-closed на непонятом файле (422, файл не трогается), сохранение всех чужих
 * ключей с проверкой проекции ДО записи, бэкап + атомарная запись, BOM/CRLF.
 *
 * Файл — вход раздела: разбор по модулям лежит в `provider-hooks/`
 * (`target.ts` — цель, форма и запрет записи, `draft.ts` — валидация черновиков,
 * `info.ts` — сводка обеих моделей, `opencode.ts` и `event-rules.ts` — запись
 * каждой модели).
 */
export type {
  ProviderHooksFormat,
  ProviderHooksShape,
  ProviderHooksTarget,
} from './provider-hooks/types.ts';
export {
  hooksShapeOf,
  resolveProviderHooksTarget,
  WriteDisabledError,
} from './provider-hooks/target.ts';
export { parseProviderHooksDraft, parseProviderHookRulesDraft } from './provider-hooks/draft.ts';
export { readProviderHooksInfo } from './provider-hooks/info.ts';
export { saveProviderHooks } from './provider-hooks/opencode.ts';
export { saveProviderHookRules } from './provider-hooks/event-rules.ts';
