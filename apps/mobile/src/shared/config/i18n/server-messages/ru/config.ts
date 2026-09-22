import type { ConfigMessageCode } from '@agentdeck/contracts/server-messages';

export const configRu: Record<ConfigMessageCode, string> = {
  'config-dir-path-required': 'Укажите путь к каталогу конфигурации.',
  'settings-invalid': 'Настройки не прошли проверку и не сохранены.',
  'state-import-invalid': 'Импортируемое состояние не прошло проверку и не применено.',
  'credentials-paste-empty': 'Пусто: вставьте JSON или ключ API.',
  'config-format-unrecognized-readonly':
    'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  'hook-event-unspecified': 'Не указано событие хука',
  'hook-direction-unspecified': 'Не указано направление',
  'mcp-server-not-found': 'Сервер не найден',
  'instructions-global-missing': 'У активного провайдера нет раздела глобальных инструкций.',
  'rule-not-found': 'Правило не найдено',
  'content-must-be-string': 'Поле content обязано быть строкой (пустая строка допустима).',
  'instructions-file-name-must-be-string': 'Имя файла инструкций обязано быть строкой.',
  'instructions-file-name-unknown':
    'Имя «{{requested}}» не из тех, что читает CLI при текущем режиме instructionFiles.',
  'instructions-file-exists':
    'Файл инструкций уже есть ({{current}}) — панель не переименовывает его и не заводит второй.',
  'group-cycle': 'Вложение групп образует цикл',
  'group-not-found': 'Группа не найдена',
  'group-state-unspecified': 'Не указано состояние группы',
  'config-format-unrecognized': 'Формат файла конфигурации не распознан — запись запрещена.',
  'plugin-unspecified': 'Не указан плагин',
  'plugin-state-unspecified': 'Не указано состояние плагина',
  'plugin-source-unspecified': 'Не указан источник',
  'plugin-dir-or-name-unspecified': 'Не указан каталог или имя плагина',
  'project-files-claude-only':
    'Проектные файлы Claude доступны только при активном провайдере Claude.',
  'prompt-gate-enabled-expected': 'Ожидается поле enabled.',
  'prompt-gate-action': 'Действие: block или warn.',
  'prompt-not-in-catalog': 'Такого промпта в каталоге нет.',
  'prompt-text-required': 'Нужен текст промпта.',
  'provider-unknown-to-panel': 'Такого провайдера панель не знает.',
  'compare-target-format-unrecognized':
    'Формат файла приёмника не распознан — панель в него не пишет.',
  'portability-importer-missing': 'Панель пока не умеет читать среду этого CLI.',
  'portability-scope-unknown': 'Уровень паспорта — «global» или «project».',
  'portability-project-required': 'Уровень проекта требует названного проекта.',
  'portability-project-unknown': 'Такого проекта в панели нет.',
  'portability-project-unsupported':
    'У этого CLI настроек уровня проекта не задокументировано — переносить их некуда.',
  'portability-target-unknown': 'Такой цели переноса панель не знает.',
  'portability-source-not-readable':
    'Файлы этого CLI не читаются: проверьте, что его настройки не испорчены.',
  'portability-emitter-missing': 'Панель пока не умеет писать среду этого CLI.',
  'portability-attachment-unsafe-path':
    'Перенос не начат: вложение «{{path}}» скилла «{{name}}» ведёт за пределы его каталога.',
  'portability-plan-not-shown':
    'Сначала предпросмотр: панель не пишет то, чего вам не показала. Откройте план переноса заново.',
  'portability-plan-stale':
    'С момента предпросмотра файлы изменились — план пересчитан. Посмотрите его заново и примените.',
  'portability-backups-off':
    'Перенос не начат: резервные копии выключены, а без них отменить его будет нечем.',
  'portability-target-not-writable':
    'Перенос не начат: файл цели недоступен для записи — он занят, только для чтения, или на диске нет места.',
  'portability-apply-rolled-back':
    'Запись не удалась — перенос отменён целиком, файлы вернулись к состоянию до него.',
  'portability-apply-rollback-failed':
    'Запись не удалась, и откат тоже: часть файлов осталась изменённой. Копии лежат в каталоге резервных копий.',
  'portability-transfer-not-found': 'Отменять нечего: переноса к этой цели панель не делала.',
  'portability-subscription-unknown': 'Подписки на эту цель нет.',
  'portability-subscription-layer-unknown': 'Такого слоя в каноне нет.',
  'portability-subscription-held':
    'Пересборка удержана: либо проекцию строила другая версия канона, либо ни один слой не подписан.',
  'portability-drift-resolution-unknown':
    'У расхождения три исхода: взять в канон, вернуть проекцию, отписать слои файла.',
  'portability-drift-absent':
    'Этот файл цели совпадает с тем, каким панель его оставила: разбирать нечего.',
  'portability-drift-file-missing':
    'Этого файла у цели нет: брать в канон нечего — верните проекцию или отпишите слои.',
  'portability-drift-nothing-to-adopt':
    'В этом файле нет записей подписанных слоёв: брать в канон нечего.',
  'portability-drift-nothing-to-do': 'Этот исход не даёт ни одной правки: посмотрите план заново.',
  'portability-carry-nothing-chosen': 'Не выбрано ни одного разговора: переносить нечего.',
  'resource-file-unspecified': 'Не указан файл',
  'resource-template-not-found': 'Шаблон не найден',
  'resource-kind-unknown': 'Неизвестный вид ресурса',
  'script-content-missing': 'Не передано содержимое скрипта',
  'script-name-unspecified': 'Не указано имя скрипта',
  'permissions-draft-invalid':
    'Значения прав не прошли проверку: они должны быть из допустимых наборов.',
  'env-draft-invalid':
    'Набор переменных не прошёл проверку: у каждой нужны непустой ключ и значение.',
  'kimi-plugins-readonly':
    'Плагины Kimi Code панель только показывает: устанавливать, включать и выключать их нужно командой /plugins внутри CLI — форма реестра установленного не задокументирована.',
  'rule-draft-invalid':
    'Правило не прошло проверку: нужен путь внутри каталога правил и текстовое тело; description и globs — однострочные, alwaysApply — булево.',
  'gemini-yolo-cli-only':
    'Режим «yolo» в settings.json записать нельзя: у Gemini он допустим только как флаг командной строки, а в файле настроек вызывает ошибку при запуске CLI. Запускайте его флагом `--yolo`.',
  'skill-draft-invalid':
    'Скилл не прошёл проверку: нужен путь вида «<имя>/SKILL.md», однострочные имя и описание и текстовое тело.',
  'plugin-npm-list-invalid':
    'Список npm-плагинов не прошёл проверку: каждое имя — непустая строка без пробелов и кавычек, повторы недопустимы.',
  'instructions-list-invalid':
    'Список файлов не прошёл проверку: каждая запись должна быть непустой строкой без переводов строк.',
  'instructions-not-rules-dir': 'У активного провайдера инструкции не устроены каталогом правил.',
  'instructions-not-link-list': 'У активного провайдера инструкции не устроены списком ссылок.',
  'project-instructions-not-link-list':
    'У активного провайдера инструкции проекта не устроены списком ссылок.',
  'project-level-unsupported': 'У активного провайдера нет проектного уровня конфигурации.',
  'project-mcp-unsupported': 'У активного провайдера нет проектного файла MCP-серверов.',
  'project-instructions-unsupported': 'У активного провайдера нет проектного файла инструкций.',
  'project-env-unsupported': 'У активного провайдера нет проектного файла переменных окружения.',
  'project-permissions-unsupported': 'У активного провайдера нет проектного файла прав/аппрувов.',
  'project-plugins-unsupported': 'У активного провайдера нет проектных плагинов.',
  'project-skills-unsupported': 'У активного провайдера нет проектных скиллов.',
  'project-hooks-unsupported': 'У активного провайдера нет проектных хуков.',
  'mcp-section-unsupported': 'У активного провайдера нет универсального раздела MCP.',
  'env-section-unsupported':
    'У активного провайдера нет универсального раздела переменных окружения.',
  'plugins-section-unsupported': 'У активного провайдера нет универсального раздела плагинов.',
  'permissions-section-unsupported':
    'У активного провайдера нет универсального раздела прав/аппрувов.',
  'skills-section-unsupported': 'У активного провайдера нет универсального раздела скиллов.',
  'hooks-section-unsupported': 'У активного провайдера нет универсального раздела хуков.',
  'project-rules-not-mdc': 'У активного провайдера правила проекта не устроены каталогом .mdc.',
  'plugin-file-draft-invalid':
    'Файл плагина не прошёл проверку: нужен путь внутри каталога плагинов (.js, .ts или .mjs) и текстовое содержимое.',
  'config-format-unrecognized-list-readonly':
    'Формат файла конфигурации не распознан — запись запрещена (список только для чтения).',
  'hooks-draft-invalid-foreign':
    'Хуки не прошли проверку. OpenCode: команда — непустой список непустых аргументов, шаблон файлов непустой и не повторяется, имена переменных окружения непустые и уникальные. Qwen и Kimi: событие — из задокументированного списка, команда непустая и в одну строку, матчер только у событий, которые его поддерживают, таймаут — целое в допустимых границах.',
  'hooks-draft-invalid':
    'Хуки не прошли проверку: команда — непустой список непустых аргументов, шаблон файлов непустой и не повторяется, имена переменных окружения непустые и уникальные.',
  'mcp-draft-invalid':
    'Черновик сервера не прошёл проверку: нужны имя, транспорт и команда (stdio) или адрес (http).',
  'provider-unknown': 'Провайдер «{{id}}» неизвестен панели.',
  'config-dir-unsuitable': 'Каталог конфигурации не подходит.',
  'config-preview-field-missing': 'Для этого действия не хватает поля (id, draft или isEnabled).',
  'automation-name-missing': 'Не указано имя сценария',
  'automation-event-missing': 'Не указано событие сценария',
  'automation-command-missing': 'Не указана команда сценария',
  'scenario-trigger-not-regex': 'Выражение триггера не является регулярным выражением',
  'env-body-empty': 'Тело запроса пустое: нужны key, value и source.',
  'env-value-string': 'Значение переменной — строка.',
  'env-comment-string': 'Комментарий — строка.',
  'env-var-not-found': 'Переменной {{key}} нет в {{file}}.',
  'group-field-string': 'Поле {{field}} ({{what}}) — строка.',
  'group-members-list': 'Поле members — список участников.',
  'group-env-object': 'Поле env — объект «имя переменной → значение».',
  'group-env-value-string': 'Значение переменной {{key}} — строка.',
  'group-scenario-object': 'Поле scenario — объект сценария.',
  'group-scenario-steps-list': 'Шаги сценария — список.',
  'group-scenario-step-object': 'Шаг сценария — объект {title, body, gate}.',
  'group-body-object': 'Тело запроса должно быть объектом с описанием набора.',
  'group-name-missing': 'Не указано имя набора',
  'group-paths-list': 'Поле projectPaths — список путей к каталогам (строк).',
  'group-enabled-boolean': 'Поле isEnabled — true или false.',
  'mcp-field-string-list': 'Поле {{field}} должно быть списком строк.',
  'mcp-field-string-map': 'Поле {{field}} должно быть объектом «имя → строка».',
  'mcp-body-object': 'Тело запроса должно быть объектом с описанием сервера.',
  'mcp-name-missing': 'Не указано имя MCP-сервера',
  'mcp-transport-invalid': 'Транспорт должен быть одним из: {{list}}.',
  'mcp-stdio-command': 'Для stdio нужна команда запуска.',
  'mcp-url-required': 'Для {{transport}} нужен адрес сервера.',
  'mcp-url-invalid': 'Адрес «{{url}}» не разбирается как http(s)-URL.',
  'permission-pattern-empty': 'Пустой шаблон права',
  'permission-decision-unknown': 'Неизвестное решение: {{decision}}',
  'compare-self': 'Сравнивать провайдера с самим собой нечего.',
  'migrate-same': 'Источник и приёмник совпадают.',
  'migrate-from-to': 'Поля from и to обязаны быть непустыми строками.',
  'migrate-mode': 'Поле mode обязано быть preview или apply.',
  'migrate-keys': 'Поле keys обязано быть списком непустых строк.',
  'migrate-source-no-mcp': 'У источника нет раздела MCP-серверов.',
  'migrate-target-no-mcp': 'У приёмника нет раздела MCP-серверов.',
  'migrate-source-no-instructions': 'У источника нет файла глобальных инструкций.',
  'migrate-target-no-instructions': 'У приёмника нет файла глобальных инструкций.',
  'migrate-instructions-missing': 'Файл инструкций источника не существует — переносить нечего.',
  'provider-unknown-quoted': 'Неизвестный провайдер «{{providerId}}».',
  'provider-key-invalid': 'Ключ пуст или превышает допустимую длину.',
  'plugin-file-not-text': 'Файл {{fullPath}} не является текстовым.',
  'preview-no-mcp': 'У активного провайдера нет раздела MCP.',
  'preview-server-unspecified': 'Не указан сервер для удаления.',
  'preview-server-draft-invalid': 'Черновик сервера не прошёл проверку.',
  'preview-no-permissions': 'У активного провайдера нет раздела прав.',
  'preview-permissions-draft-invalid': 'Черновик прав не прошёл проверку.',
  'preview-no-env': 'У активного провайдера нет раздела переменных окружения.',
  'preview-env-draft-invalid': 'Черновик переменных не прошёл проверку.',
  'preview-no-instructions-list': 'У активного провайдера нет списка файлов инструкций.',
  'preview-list-draft-invalid': 'Черновик списка не прошёл проверку.',
  'skill-name-invalid': 'Недопустимое имя скилла.',
  'skill-not-found': 'Скилл не найден.',
  'skill-name-taken': 'Скилл с таким именем уже есть.',
  'mdc-yaml': 'Frontmatter правила не разбирается как YAML.',
  'mdc-not-map': 'Frontmatter правила не является отображением ключей.',
  'mdc-roundtrip-intent': 'Контрольный разбор правила не совпал с намерением.',
  'mdc-roundtrip-body': 'Контрольный разбор изменил тело правила.',
  'mdc-roundtrip-keys': 'Контрольный разбор потерял ключи frontmatter.',
  'skill-head-yaml': 'Шапка скилла не разбирается как YAML.',
  'skill-head-not-map': 'Шапка скилла не является отображением ключей.',
  'skill-head-field-missing': 'В шапке скилла нет обязательного поля «{{key}}».',
  'skill-head-field-string': 'Поле «{{key}}» в шапке скилла — не строка.',
  'skill-head-field-empty': 'Обязательное поле «{{key}}» в шапке скилла пустое.',
  'skill-roundtrip-intent': 'Контрольный разбор скилла не совпал с намерением.',
  'skill-roundtrip-body': 'Контрольный разбор изменил тело скилла.',
  'skill-roundtrip-keys': 'Контрольный разбор потерял ключи шапки скилла.',
  'hook-not-found': 'Хук не найден',
  'hook-script-separate': 'Скрипт хука создаётся отдельным действием.',
  'script-not-found-quoted': 'Скрипт «{{id}}» не найден',
  'skill-not-found-quoted': 'Скилл «{{id}}» не найден',
  'migrate-env-refused': 'Переменные окружения панель не переносит: в них хранятся ключи.',
  'migrate-permissions-refused': 'Права не переносятся: у CLI разные модели согласований.',
  'migrate-section': 'Поле section обязано быть одним из: mcp, env, permissions, instructions.',
  'migrate-source-server-missing': 'У источника такого сервера нет.',
  'compare-format-unreadable': 'Формат файла не распознан — читать его панель не станет.',
  'compare-file-absent':
    'Файла нет — CLI не установлен или ещё ничего не настроил. Перенос сюда создаст файл.',
  'compare-mcp-unsupported': 'У этого CLI панель не ведёт MCP-серверы.',
  'compare-env-unsupported': 'У этого CLI панель не ведёт переменные окружения.',
  'compare-permissions-unsupported': 'У этого CLI панель не ведёт права.',
  'compare-instructions-unsupported':
    'У этого CLI глобальные инструкции устроены иначе — не одним файлом.',
  'compare-sse-blocked': 'Транспорт sse: у других CLI его нет, переносить некуда.',
  'compare-disabled-blocked': 'Сервер выключен — переносим только включённые.',
  'compare-env-note':
    'Переменные не переносятся: их значения — обычно ключи и токены, а секреты панель в чужие конфигурации не пишет.',
  'compare-permissions-note':
    'У каждого CLI своя модель согласований. Совпадение имён ключей не означает совпадения смысла, поэтому права показаны рядом, но не переносятся.',
  'instructions-entry-unlisted': 'Записи «{{raw}}» нет в списке read конфигурации {{configPath}}.',
  'instructions-entry-outside':
    'Путь «{{raw}}» выходит за пределы каталога проекта — панель его не открывает.',
  'instructions-entry-missing':
    'Файл {{path}} не существует. Панель не создаёт файлы, которых нет: создайте его сами или уберите запись из списка.',
  'instructions-entry-directory': 'Путь {{path}} — каталог, а не файл.',
  'instructions-entry-too-large': 'Файл {{path}} слишком большой для правки в панели.',
  'instructions-entry-binary': 'Файл {{path}} не является текстовым — панель его не открывает.',
  'skill-not-found-in-dir': 'Скилл «{{path}}» не найден в каталоге скиллов.',
  'skill-name-empty': 'Имя скилла «{{name}}» не годится: имя обязательно.',
  'skill-name-too-long': 'Имя скилла «{{name}}» не годится: имя длиннее {{max}} символов.',
  'skill-name-leading-hyphen':
    'Имя скилла «{{name}}» не годится: имя не может начинаться с дефиса.',
  'skill-name-trailing-hyphen':
    'Имя скилла «{{name}}» не годится: имя не может заканчиваться дефисом.',
  'skill-name-double-hyphen': 'Имя скилла «{{name}}» не годится: два дефиса подряд запрещены.',
  'skill-name-pattern':
    'Имя скилла «{{name}}» не годится: допустимы только строчные латинские буквы, цифры и одиночные дефисы.',
  'skill-name-dir-mismatch':
    'Имя скилла «{{name}}» обязано совпадать с именем его папки «{{dirName}}».',
  'skill-description-empty':
    'Описание скилла обязательно: по нему CLI решает, когда его подключать.',
  'skill-description-too-long': 'Описание скилла длиннее {{max}} символов.',
  'script-exists': 'Скрипт «{{id}}» уже есть. Выберите другое имя или откройте его для правки.',
  'skill-id-invalid': 'Недопустимый идентификатор скилла: «{{id}}»',
  'skill-exists': 'Скилл «{{skillId}}» уже существует',
  'skill-exists-disabled': 'Скилл «{{skillId}}» уже существует и сейчас выключен',
  'credentials-file-unreadable': 'Файл {{path}} не читается — проверьте права доступа.',
  'credentials-file-not-json':
    'Файл {{path}} — не JSON. Исправьте его или удалите: панель тогда вернётся к обычному поиску.',
  'credentials-read-from-missing': 'Указанный файл не найден: {{path}}',
  'credentials-read-from-unreadable': 'Файл {{path}} не читается.',
  'credentials-file-no-field':
    'В файле {{path}} нет ни одного известного поля: ожидается claudeAiOauth, apiKey или readFrom.',
  'credentials-not-found-mac':
    'Ни в связке ключей macOS, ни в файле доступ не найден. Войдите командой `claude` в терминале или задайте доступ вручную в настройках панели.',
  'credentials-not-found':
    'Файл {{path}} не найден. Войдите командой `claude` в терминале или задайте доступ вручную в настройках панели.',
  'credentials-paste-not-json': 'Это не JSON. Проверьте кавычки и запятые.',
  'credentials-paste-file-missing': 'Файл не найден: {{path}}',
  'credentials-paste-directory': 'Это каталог, а не файл: {{path}}',
  'credentials-paste-unreadable': 'Файл не читается: {{path}}',
  'credentials-paste-no-token': 'В claudeAiOauth нет поля accessToken со строкой.',
  'credentials-paste-no-field':
    'Нужно одно из полей: claudeAiOauth (с accessToken), apiKey или readFrom.',
  'mcp-server-exists': 'MCP-сервер «{{name}}» уже есть в конфигурации.',
  'mcp-field-map-invalid':
    'Поле {{field}}: имя «{{key}}» без пробелов и служебных символов, значение — строкой.',
  'mcp-name-invalid':
    'Имя «{{name}}» не годится: без пробелов, косых черт и двойного подчёркивания — по нему строятся права вида mcp__сервер__инструмент.',
  'mcp-vars-missing':
    'Не заданы переменные {{names}}: добавьте их в разделе «Переменные» (settings.json → env или .mcp-secrets.env) либо в окружение, из которого запущена панель',
  'mcp-oauth-no-verifier': 'Авторизация не начата: нет code_verifier',
  'endpoint-base-url-invalid': 'Адрес эндпоинта должен быть корректным http(s)-адресом.',
  'endpoint-google-https-only':
    'Gemini CLI принимает по своей переменной адреса только https — исключение сделано лишь для localhost.',
  'endpoint-provider-no-var':
    'У «{{provider}}» нет задокументированной переменной окружения для этого вида API — профиль сюда не переносится.',
  'endpoint-provider-no-env': 'У «{{provider}}» нет раздела переменных окружения — писать некуда.',
  'hook-file-exists':
    'Файл hooks/{{name}} уже есть. Укажите другое имя файла или оставьте поле пустым и задайте команду.',
  'permission-rule-exists': 'Правило «{{pattern}}» с таким решением уже есть',
  'permission-not-found': 'Право «{{id}}» не найдено',
  'script-not-found': 'Скрипт «{{id}}» не найден',
  'provider-declared-only':
    'Провайдер «{{id}}» на этой фазе только объявлен: файловый адаптер не реализован, чтение/запись запрещены.',
  'provider-no-model-api':
    'У провайдера «{{provider}}» нет собственного модельного API — ключ задать нельзя.',
  'provider-env-value-unsupported':
    'Переменная «{{key}}» задана в config.toml значением, которое панель не моделирует (число, булево или таблица), — переименуйте её здесь или измените значение в файле вручную. Остальные переменные не сохранены.',
  'file-too-large-to-edit': 'Файл {{path}} слишком большой для правки в панели.',
  'file-too-large-to-view': 'Файл слишком большой для просмотра',
  'skill-no-frontmatter':
    'В файле нет блока frontmatter между строками «---» — OpenCode такой скилл не подключает.',
  'mcp-tools-server-disabled': 'Сервер выключен — включите его, чтобы увидеть инструменты',
  'mcp-server-not-in-config': 'MCP-сервера «{{name}}» нет в конфигурации.',
  'endpoint-probe-not-json': 'Ответ не является JSON — по адресу отвечает не модельный API.',
  'endpoint-probe-status': 'Адрес ответил {{status}}{{detail}}',
  'instructions-section-unsupported': 'Активный CLI не поддерживает глобальные инструкции.',
};
