/**
 * Раздел «Инструкции» в модели КАТАЛОГА ПРАВИЛ (CURSOR-1) — третья модель.
 *
 * Первые две: `domains/instructions.ts` — ОДИН файл (Claude/Codex/Gemini/
 * OpenCode); `domains/provider-instructions.ts` — СПИСОК ССЫЛОК (Aider, ключ
 * `read`). У Cursor не подходит ни та, ни другая: по документации его правила —
 * это КАТАЛОГ файлов `.mdc` (глобальный `~/.cursor/rules/`, проектный
 * `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются), где каждый
 * файл несёт свой frontmatter с полями `description` / `globs` / `alwaysApply`.
 *
 * ТА ЖЕ МОДЕЛЬ У CONTINUE (формат `continue-md`), только расширение другое:
 * правила проекта лежат в `<проект>/.continue/rules/` файлами `.md` с тем же
 * frontmatter (`globs`, `alwaysApply`, `description`) плюс своим ключом `name` —
 * им панель не управляет, но сохраняет. Файл без frontmatter Continue правилом
 * СЧИТАЕТ, а панель его не переписывает (только показывает): переписывать вслепую
 * то, форму чего не разобрали, нельзя.
 *
 * ЧТО ДЕЛАЕТ РАЗДЕЛ:
 *  1. перечисляет все `*.mdc` рекурсивно, показывая по каждому относительный
 *     путь, три поля frontmatter, размер и признак «frontmatter не разобран»;
 *  2. отдельно перечисляет файлы каталога, которые Cursor ИГНОРИРУЕТ (обычный
 *     `.md` без frontmatter и любое другое расширение) — панель их не правит;
 *  3. открывает одно правило: поля frontmatter отдельно, markdown-тело отдельно;
 *  4. создаёт / обновляет / удаляет правило (бэкап + атомарная запись +
 *     сохранение формы файла; при записи целы комментарии frontmatter и все
 *     ключи, которыми панель не управляет).
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — главное здесь. Клиент присылает путь ОТНОСИТЕЛЬНО каталога
 * правил, и он обязан разрешаться ВНУТРИ него. Отклоняются: пустое имя, `..` в
 * любом сегменте, абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`), расширение
 * не `.mdc`, а также путь, любой сегмент которого — символическая ссылка (через
 * неё можно было бы выйти наружу). Отказ = `UnsafeRulePathError` → 400
 * `unsafe_path`, ни чтения, ни записи, ни удаления. Ровно то же — при удалении.
 *
 * FAIL-CLOSED: frontmatter правила не разбирается (или его нет вовсе) → правило
 * показывается ТОЛЬКО ДЛЯ ЧТЕНИЯ, запись по нему 422; каталог не читается →
 * весь раздел только для чтения.
 *
 * ЧЕГО РАЗДЕЛ НЕ ДЕЛАЕТ: не создаёт каталог правил и подкаталоги «на всякий
 * случай» — они появляются только при ЯВНОМ сохранении правила по такому пути.
 *
 * Файл — вход раздела: разбор по модулям лежит в `provider-rules/`
 * (`paths.ts` — цель и защита путей, `read.ts` — список и одно правило,
 * `write.ts` — черновик, запись и удаление, `errors.ts` — отказы и их коды).
 */
export type { ProviderRulesTarget } from './provider-rules/types.ts';
export {
  UnsafeRulePathError,
  RuleNotEditableError,
  RuleNotFoundError,
  describeRuleError,
} from './provider-rules/errors.ts';
export { resolveProviderRulesTarget, resolveRulePath } from './provider-rules/paths.ts';
export { readProviderRulesInfo, readProviderRule } from './provider-rules/read.ts';
export {
  parseProviderRuleDraft,
  saveProviderRule,
  deleteProviderRule,
} from './provider-rules/write.ts';
