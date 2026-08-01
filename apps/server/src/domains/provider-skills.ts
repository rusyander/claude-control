/**
 * Раздел «Скиллы» у НЕ-Claude провайдера (OPENCODE-5).
 *
 * Понятие ТО ЖЕ, что в разделе скиллов Claude (`domains/skills.ts`, маршруты
 * `/api/skills`): скилл — папка с файлом `SKILL.md`, у которого в начале
 * YAML-шапка. Тот раздел не меняется ни на строку; здесь — каталог скиллов
 * ЧУЖОГО CLI, у которого свои пути и свой набор полей шапки.
 *
 * У OpenCode задокументированы два каталога:
 *  - глобальный `~/.config/opencode/skills/<имя>/SKILL.md`;
 *  - проектный `<проект>/.opencode/skills/<имя>/SKILL.md`.
 *
 * ЧТО ДЕЛАЕТ РАЗДЕЛ: перечисляет скиллы (имя, описание, путь, признак проблемы),
 * открывает один скилл, создаёт, обновляет и удаляет — ровно как раздел скиллов
 * Claude, чтобы пользоваться было привычно.
 *
 * ПРОВЕРКА ИМЕНИ ДО ЗАПИСИ (иначе OpenCode скилл не подхватит): 1–64 символа,
 * строчные буквы и цифры, одиночный дефис-разделитель, не в начале и не в конце,
 * без `--`, и `name` обязано СОВПАДАТЬ С ИМЕНЕМ ПАПКИ. `description` — 1–1024
 * символа. Нарушение → 400, файл не тронут.
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — как у правил Cursor и плагинов OpenCode. Клиент присылает
 * путь ОТНОСИТЕЛЬНО каталога скиллов, и он обязан разрешаться ВНУТРИ него, имея
 * РОВНО форму `<имя>/SKILL.md`. Отклоняются: пустое имя, `.`/`..`/пустой сегмент,
 * абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`), нулевой байт, любая другая
 * форма пути и путь, любой сегмент которого — символическая ссылка. Отказ = 400
 * `unsafe_path` ВСЕГДА, никогда 404: существует ли что-то за пределами каталога —
 * не наше дело сообщать. Одинаково на чтении, записи и удалении.
 *
 * FAIL-CLOSED: шапка не разобрана → скилл только для чтения (GET отдаёт файл как
 * есть, PUT 422, файл байт-в-байт прежний); каталог не читается → весь раздел
 * только для чтения. Каталог и папки скиллов создаются ТОЛЬКО при явном
 * сохранении.
 *
 * Файл — вход раздела: разбор по модулям лежит в `provider-skills/`
 * (`paths.ts` — цель, внешние каталоги и защита путей, `read.ts` — список и один
 * скилл, `write.ts` — черновик, правила имени, запись и удаление, `errors.ts` —
 * отказы и их коды).
 */
export type { ProviderSkillsTarget } from './provider-skills/types.ts';
export {
  UnsafeSkillPathError,
  SkillNotFoundError,
  SkillNotEditableError,
  InvalidSkillDraftError,
  describeSkillError,
} from './provider-skills/errors.ts';
export {
  opencodeExternalSkillDirs,
  resolveProviderSkillsTarget,
  resolveSkillPath,
} from './provider-skills/paths.ts';
export { readProviderSkillsInfo, readProviderSkill } from './provider-skills/read.ts';
export {
  parseProviderSkillDraft,
  assertSkillDraft,
  saveProviderSkill,
  deleteProviderSkill,
} from './provider-skills/write.ts';
