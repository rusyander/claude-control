/**
 * Канон переносимой среды — словарь СМЫСЛА, а не архив файлов.
 *
 * Партия переноса среды между провайдерами (`TASKS-PORTABILITY.md`) держится на
 * одном предположении: перенести можно только то, чему панель умеет назвать
 * смысл. Поэтому импортёр каждого CLI приводит прочитанное к записям этого
 * словаря, а эмиттер собирает из них файлы цели. Пары «источник → приёмник» в
 * коде нет: обе половины знают только канон.
 *
 * СЕРДЦЕ СЛОВАРЯ — `needs`. Уровень верности (нативно · эмуляция · провод ·
 * текстом · невозможно) не объявляется рукой в таблице, а ВЫЧИСЛЯЕТСЯ из того,
 * какие факты рантайма записи нужны и что из них умеет целевой CLI. Хук,
 * которому нужны `tool_name` и `tool_input`, на CLI без событий инструментов
 * нативно работать не может — это следует из данных, а не из чьего-то мнения.
 * Отсюда же запрет на пустой массив по умолчанию: «ничего не нужно» — это
 * утверждение, и оно обязано быть сказано вслух (см. `EnvNeeds`).
 *
 * МОДУЛЬ САМОДОСТАТОЧЕН И БЕЗ ZOD, как `rule-format.ts` и `platform-layers.ts`:
 * сервер под `--experimental-strip-types` берёт его точкой экспорта
 * `@agentdeck/contracts/portable-env`, минуя бочку. Здесь не должно появиться ни
 * одного импорта; схемы проверки живут отдельно — `portable-env-schema.ts`.
 *
 * Двенадцать видов записи покрывают четырнадцать строк матрицы плана: две
 * строки хуков — один вид (события сессии и события инструментов различает
 * `trigger`, и именно это различие считает матрица), а «поведение CLI» каноном
 * не едет вовсе — модель и её подбор уже решены `domains/provider-cascade.ts`,
 * остальное поведение не переносится ни в каком виде.
 */

/**
 * Версия канона. Участвует в отпечатке среды: смена версии делает старый
 * паспорт нечитаемым ЯВНО (`checkCanonVersion`), а не тихо совместимым — иначе
 * подписка сверяла бы отпечатки разных словарей и считала расхождение правкой
 * человека.
 *
 * Вторая версия — волна П2.6: у скилла появилась опись вложений, у права и
 * MCP-сервера — состояние вкл/выкл, у происхождения — плагин, а у среды —
 * рубильники разделов. Поля необязательными не сделаны намеренно: паспорт,
 * который МОЖЕТ нести вложения, а может и не нести, читающий не отличит от
 * паспорта, где вложений нет, — а это разные среды.
 */
export const CANON_VERSION = 2;

export type CanonVersion = typeof CANON_VERSION;

/**
 * Факты рантайма, которые запись может требовать. Словарь ЗАКРЫТ: новое
 * значение невозможно без правки этой строки, и это намеренно — каждое значение
 * стоит столбца в матрице верности и ветки в вычислении уровня.
 *
 * - `tool_name`, `tool_input`, `tool_result` — событие инструмента и его
 *   нагрузка (у большинства чужих CLI этого нет: уровень «провод»);
 * - `prompt` — текст запроса человека до отправки модели;
 * - `transcript` — путь к расшифровке разговора;
 * - `cwd` — рабочий каталог запуска;
 * - `session_id` — идентификатор сессии CLI;
 * - `subagent` — факт запуска и остановки субагента;
 * - `compact` — сжатие контекста.
 */
export const envNeeds = [
  'tool_name',
  'tool_input',
  'tool_result',
  'prompt',
  'transcript',
  'cwd',
  'session_id',
  'subagent',
  'compact',
] as const;

export type EnvNeed = (typeof envNeeds)[number];

export function isEnvNeed(value: string): value is EnvNeed {
  return (envNeeds as readonly string[]).includes(value);
}

/**
 * Откуда взялся список `needs`. Слабейший способ не признаётся достаточным:
 * статический разбор скрипта — гипотеза, живое наблюдение — факт (П0.2), а
 * `declared` — то, что провайдер объявляет сам своим форматом (событие хука в
 * конфиге задаёт нагрузку однозначно).
 */
export const needsEvidences = ['declared', 'static', 'observed'] as const;

export type NeedsEvidence = (typeof needsEvidences)[number];

/**
 * Требования записи к рантайму. Не массив, а РЕШЕНИЕ из трёх исходов, потому
 * что пустой массив в этом месте — ложь: он одинаково означает «ничего не
 * нужно» и «разобрать не смогли», а уровень верности у этих двух случаев
 * противоположный.
 *
 * - `facts` — список непустой (пустого кортежа тип не принимает);
 * - `none` — сказано вслух, что рантайм записи не нужен, и сказано почему;
 * - `undetermined` — вывести не удалось (динамический доступ `payload[key]`,
 *   вызов другого скрипта, нечитаемый файл). Даёт ХУДШИЙ уровень и требует
 *   решения человека, а не молчаливого «ничего не нужно».
 */
export type EnvNeeds =
  | {
      readonly resolution: 'facts';
      readonly facts: readonly [EnvNeed, ...EnvNeed[]];
      readonly evidence: NeedsEvidence;
    }
  | { readonly resolution: 'none'; readonly why: string }
  | { readonly resolution: 'undetermined'; readonly why: string };

/** События сессии — те, что не про инструменты. */
export const sessionEvents = [
  'session_start',
  'session_end',
  'stop',
  'subagent_stop',
  'notification',
  'pre_compact',
] as const;

export type SessionEvent = (typeof sessionEvents)[number];

/** События инструмента — единственная пара, вокруг которой живёт «провод». */
export const toolEvents = ['pre_tool', 'post_tool'] as const;

export type ToolEvent = (typeof toolEvents)[number];

/**
 * Чем запись запускается. Различие «событие сессии» против «события
 * инструмента» здесь не украшение: по нему матрица разводит две строки хуков, и
 * оно же решает, хватит ли цели своих событий или нужен провод.
 *
 * `model` — решает сама модель (скилл, субагент), `user` — человек вызывает
 * (слэш-команда), `always` — действует постоянно (инструкции, права,
 * переменные), `prompt` — срабатывает на отправку запроса.
 */
export type EnvTrigger =
  | { readonly on: 'session'; readonly event: SessionEvent }
  | { readonly on: 'tool'; readonly event: ToolEvent; readonly match: string | null }
  | { readonly on: 'prompt' }
  | { readonly on: 'model' }
  | { readonly on: 'user' }
  | { readonly on: 'always' };

/**
 * Останавливает ли запись действие. Инвариант 6 партии: блокирующее не имеет
 * права молча стать наблюдательным, поэтому «неприменимо» — отдельное значение,
 * а не `false`: у инструкций блокировки нет в принципе, и путать её с
 * деградировавшей блокировкой нельзя.
 */
export const envBlockings = ['blocks', 'observes', 'inapplicable'] as const;

export type EnvBlocking = (typeof envBlockings)[number];

/** Что запись делает с системой — для предупреждения человеку перед переносом. */
export const envSideEffects = [
  'writes_files',
  'runs_process',
  'network',
  'reads_secrets',
  'changes_prompt',
] as const;

export type EnvSideEffect = (typeof envSideEffects)[number];

/** Виды записи канона — по строкам матрицы «слой × провайдер». */
export const envItemKinds = [
  'instructions',
  'skill',
  'command',
  'subagent',
  'hook',
  'permission',
  'mcpServer',
  'envVar',
  'secret',
  'plugin',
  'panelGroup',
  'conversation',
] as const;

export type EnvItemKind = (typeof envItemKinds)[number];

export function isEnvItemKind(value: string): value is EnvItemKind {
  return (envItemKinds as readonly string[]).includes(value);
}

/** Уровень, на котором лежит запись: дом человека или конкретный проект. */
export const envScopes = ['global', 'project'] as const;

export type EnvScope = (typeof envScopes)[number];

/**
 * Где запись жила у источника.
 *
 * `origin` отличает файл на диске от того, что файлом не является: с 2.1.275
 * скилл или плагин может быть синхронизирован с аккаунтом и на диске
 * отсутствовать, а `panel` — конструкции самой панели (группы, разговоры).
 * Запись без файла едет каноном честно, а не пустым телом; `file` тогда `null`.
 *
 * `default` — умолчание самого CLI: оно ДЕЙСТВУЕТ (режим подтверждений Codex
 * спрашивает и без `config.toml`), но человек его не писал, и файла у него нет.
 * Раньше такая запись ехала как `file` с `file: null` — происхождение «файл» у
 * того, чего ни в одном файле нет; перенос (П2) решает по `origin`, и записывать
 * в цель чужое умолчание как настройку человека он не имеет права.
 */
export const envOrigins = ['file', 'account', 'panel', 'default'] as const;

export type EnvOrigin = (typeof envOrigins)[number];

export interface EnvSource {
  /** Идентификатор провайдера из каталога: строка, а не закрытый набор, — иначе одиннадцатый CLI правил бы контракты. */
  readonly provider: string;
  readonly scope: EnvScope;
  readonly origin: EnvOrigin;
  /** Путь файла-источника; `null` у записей, которых на диске нет. */
  readonly file: string | null;
  /**
   * Плагин, который принёс эту запись, — `<плагин>@<магазин>`; `null` у записей
   * человека. Плагин раскладывается на обычные записи (П2.6), и без этого поля
   * скилл плагина был бы неотличим от собственного: человек не узнал бы, что
   * перенёс чужой набор, а повторная установка плагина у цели дала бы второй
   * экземпляр того же скилла.
   */
  readonly plugin: string | null;
}

/**
 * Общая часть любой записи.
 *
 * `id` — идентичность внутри канона (`<вид>:<имя>`), по нему идёт идемпотентный
 * upsert: повторное применение того же плана не удваивает записи (инвариант 10).
 * `intent` — одна фраза человеку: он читает паспорт среды, а не файлы.
 */
interface EnvItemBase {
  readonly id: string;
  readonly kind: EnvItemKind;
  readonly source: EnvSource;
  readonly intent: string;
  readonly trigger: EnvTrigger;
  readonly blocking: EnvBlocking;
  readonly needs: EnvNeeds;
  readonly sideEffects: readonly EnvSideEffect[];
}

/**
 * Исходный кусок источника — чтобы вернуть запись точно такой же, какой взяли.
 * Есть у всех видов, КРОМЕ секрета: значение ключа в канон не попадает вовсе
 * (инвариант 5), и поле, в которое его можно было бы случайно положить, здесь
 * не заводится.
 */
interface WithRaw {
  readonly raw: string;
}

/** Инструкции и память: один файл целиком, с развёрнутыми `@`-импортами. */
export interface InstructionsItem extends EnvItemBase, WithRaw {
  readonly kind: 'instructions';
  /** Имя файла у источника: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` — оно же решение человека (П2.7). */
  readonly fileName: string;
  /** Плоский текст после раскрытия импортов. */
  readonly text: string;
  /** Файлы, из которых текст собран: карта «откуда что пришло». */
  readonly includes: readonly string[];
  /** Формат, который сам CLI читает как устаревший (`projectInstructions`). */
  readonly legacy: boolean;
  /**
   * Действует ли запись. У файла инструкций это всегда `true` (файл либо есть,
   * либо его нет), у правила `## ПРАВИЛО:` — его состояние в панели: выключенное
   * правило лежит в служебном разделе и в работу не идёт. Поле обязано доехать
   * до цели: перенос, в котором выключенное правило стало действующим, молча
   * меняет поведение — та же цена, что и у потерянного `omitClaudeMd`.
   */
  readonly enabled: boolean;
}

/**
 * Почему вложение скилла не поехало. Словарь ЗАКРЫТ и причина у каждого файла
 * своя: фраза «часть вложений не влезла» человеку бесполезна — он не знает, чего
 * лишился, и не может решить, важно ли это.
 */
export const attachmentSkipReasons = [
  /** Файл крупнее потолка на один файл. */
  'file_too_large',
  /** Файл не влез в потолок всего скилла (предыдущие уже его выбрали). */
  'skill_too_large',
  /** Не прочитан: права, битая ссылка, исчез между обходом и чтением. */
  'not_readable',
  /** Ссылка ведёт ЗА пределы каталога скилла: копия увезла бы чужое дерево. */
  'link_outside',
] as const;

export type AttachmentSkipReason = (typeof attachmentSkipReasons)[number];

/**
 * Файл внутри каталога скилла, кроме самого `SKILL.md`: `references/`,
 * `scripts/`, что угодно ещё. Канон везёт ОПИСЬ, а не содержимое: перенос идёт
 * на одной машине, и эмиттер копирует файл из каталога-источника — ровно как
 * хук зовётся по своему пути, а не переписывается в чужой конфиг телом. Иначе
 * каждый ответ маршрута и каждый показ паспорта тащил бы мегабайты, а ключ,
 * забытый в `scripts/`, уезжал бы в JSON.
 */
export interface SkillAttachment {
  /** Путь ОТНОСИТЕЛЬНО каталога скилла, разделитель всегда `/`. */
  readonly path: string;
  readonly bytes: number;
  /** sha256 содержимого: по нему видно, что у цели лежит тот же файл. */
  readonly sha256: string;
}

/** Вложение, которое в перенос не попало, — с именем файла и причиной. */
export interface SkillAttachmentSkip {
  readonly path: string;
  readonly bytes: number;
  readonly reason: AttachmentSkipReason;
}

/** Скилл: каталог с `SKILL.md`, либо запись без файла при синхронизации с аккаунтом. */
export interface SkillItem extends EnvItemBase, WithRaw {
  readonly kind: 'skill';
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /** Каталог скилла; `null` — скилла нет на диске (аккаунт). */
  readonly dir: string | null;
  readonly enabled: boolean;
  /**
   * Опись поддерева скилла. Скилл — это КАТАЛОГ: справка в `references/` и
   * скрипты в `scripts/` для него не украшение, и скилл, доехавший одним
   * `SKILL.md`, у цели ссылается на файлы, которых там нет.
   */
  readonly attachments: readonly SkillAttachment[];
  /** Что в потолок не влезло или не прочиталось — поимённо. */
  readonly attachmentsSkipped: readonly SkillAttachmentSkip[];
}

/** Слэш-команда: подкаталог даёт пространство имён (`/dir:name`). */
export interface CommandItem extends EnvItemBase, WithRaw {
  readonly kind: 'command';
  readonly name: string;
  readonly namespace: string | null;
  readonly description: string;
  readonly prompt: string;
}

/** Субагент: единственный вид, читателя которого в панели не было вовсе (П0.2). */
export interface SubagentItem extends EnvItemBase, WithRaw {
  readonly kind: 'subagent';
  readonly name: string;
  readonly description: string;
  /** Набор инструментов; `null` — «все», как и понимает сам CLI. */
  readonly tools: readonly string[] | null;
  readonly model: string | null;
  /** `omitClaudeMd` заголовочного блока: субагент не получает общие инструкции. */
  readonly omitInstructions: boolean;
}

/**
 * Хук — произвольный код. Приехавший извне канон несёт `enabled: false`
 * (инвариант 9): включение каждого скрипта — отдельное подтверждение человека с
 * показанным содержимым. Единица таймаута разная у разных CLI (`qwen` — мс,
 * `kimi` — с), поэтому она едет вместе со значением, а не подразумевается.
 */
export interface HookItem extends EnvItemBase, WithRaw {
  readonly kind: 'hook';
  readonly command: string;
  /** Путь скрипта, если команда его зовёт: по нему проверяется, что скрипт с диска человека. */
  readonly scriptPath: string | null;
  readonly timeout: { readonly value: number; readonly unit: 'ms' | 's' } | null;
  readonly enabled: boolean;
}

/**
 * Решения правила. ПОРЯДОК МАССИВА ЗНАЧИМ — от слабого к строгому: по нему
 * матрица верности выбирает, чем заменить решение, которого у цели нет.
 * Понижение допускается только ВПРАВО по этому списку (инвариант 6): `ask`,
 * записанный как `deny`, — лишняя строгость; записанный как `allow` — молча
 * снятый запрет.
 */
export const permissionDecisions = ['allow', 'ask', 'deny'] as const;

export type PermissionDecision = (typeof permissionDecisions)[number];

/** Право: одно правило грамматики источника плюс решение. Порядок значим у `kimi`. */
export interface PermissionItem extends EnvItemBase, WithRaw {
  readonly kind: 'permission';
  readonly rule: string;
  readonly decision: PermissionDecision;
  readonly order: number;
  /**
   * Действует ли правило. Выключенное право панель убирает из списка настроек и
   * помнит у себя, поэтому в файле его нет — но в СРЕДЕ человека оно есть, и
   * паспорт без него описывает чужую среду. Поле обязано доехать: правило,
   * приехавшее к цели действующим, меняет её поведение молча.
   */
  readonly enabled: boolean;
}

/** Транспорты MCP; `sdk` — сервер внутри процесса SDK, переносу не подлежит вовсе. */
export const mcpTransports = ['stdio', 'http', 'sse', 'sdk'] as const;

export type McpTransport = (typeof mcpTransports)[number];

/** MCP-сервер. Значений переменных здесь нет — только имена ключей. */
export interface McpServerItem extends EnvItemBase, WithRaw {
  readonly kind: 'mcpServer';
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly envKeys: readonly string[];
  /**
   * Поднимает ли его CLI. Выключенный сервер лежит в служебном разделе того же
   * файла (`mcpServersDisabled`), то есть состояние ФАЙЛОВОЕ и переносимое: цель
   * с тем же разделом получает сервер выключенным, а не теряет его.
   */
  readonly enabled: boolean;
}

/** Переменная окружения — значение не секретно по построению (секрет — отдельный вид). */
export interface EnvVarItem extends EnvItemBase, WithRaw {
  readonly kind: 'envVar';
  readonly name: string;
  readonly value: string;
}

/**
 * Секрет: имя и маска, значения нет и быть не может. Ключ доезжает до чужого
 * CLI окружением процесса при запуске и нигде не сохраняется (инвариант 5),
 * поэтому канон знает только ФАКТ наличия и того, кто держит значение.
 */
export interface SecretItem extends EnvItemBase {
  readonly kind: 'secret';
  readonly name: string;
  /** Маска вида `sk-…abcd` — ровно то, что панель показывает на экране. */
  readonly mask: string;
  readonly holder: 'panel' | 'provider';
}

/**
 * Чем плагин ЯВЛЯЕТСЯ у источника — а не чем он назван.
 *
 * Форма решает, можно ли увезти сам плагин, и ответ у трёх форм разный:
 *
 *  - `module` — файл кода, который CLI подхватывает из своего каталога
 *    (`opencode`: `plugins/*.ts`). Содержимое едет целиком: это обычный файл.
 *  - `package` — имя npm-пакета в списке конфига (`opencode`: ключ `plugin`).
 *    Едет ИМЯ; ставит пакет сам CLI, и установка у цели вне объёма партии.
 *  - `installed` — единица, которой владеет чужой магазин или реестр (`claude`:
 *    `installed_plugins.json`, `kimi`: `plugins/managed/`). Такую единицу
 *    записать нельзя нигде: у цели нет ни её кода, ни её реестра, а выдумать
 *    имя пакета по имени плагина значило бы угадать чужой формат. Едет
 *    СОДЕРЖИМОЕ — скиллы, команды, хуки, субагенты обычными записями.
 */
export const pluginForms = ['module', 'package', 'installed'] as const;

export type PluginForm = (typeof pluginForms)[number];

/** Плагин как единица. Едет только в `opencode`; его содержимое — обычными записями (П2.6). */
export interface PluginItem extends EnvItemBase, WithRaw {
  readonly kind: 'plugin';
  readonly name: string;
  readonly version: string | null;
  /** Чем плагин является у источника: от формы зависит, переносима ли единица. */
  readonly form: PluginForm;
  /** Раздел read-only у источника (`kimi`: состоянием владеет его команда `/plugins`). */
  readonly readOnly: boolean;
  /** Какие виды записей плагин приносит с собой. */
  readonly provides: readonly EnvItemKind[];
  /**
   * Включён ли плагин у источника. Выключенный СОДЕРЖИМЫМ не раскладывается: у
   * команды и субагента состояния вкл/выкл в каноне нет, и приехав к цели, они
   * работали бы — а у источника молчат (П2.6).
   */
  readonly enabled: boolean;
}

/** Группа панели: конструкция самой панели, у чужого CLI её нет ни у кого. */
export interface PanelGroupItem extends EnvItemBase, WithRaw {
  readonly kind: 'panelGroup';
  readonly name: string;
  readonly description: string;
  /** Идентификаторы записей канона, входящих в группу. */
  readonly members: readonly string[];
}

/** Контекст разговора: переносится смысл, а не транскрипт (транскрипт — вне объёма партии). */
export interface ConversationItem extends EnvItemBase, WithRaw {
  readonly kind: 'conversation';
  readonly title: string;
  readonly turns: number;
  readonly lastActiveIso: string;
  readonly workdir: string | null;
}

/** Любая запись канона. */
export type EnvItem =
  | InstructionsItem
  | SkillItem
  | CommandItem
  | SubagentItem
  | HookItem
  | PermissionItem
  | McpServerItem
  | EnvVarItem
  | SecretItem
  | PluginItem
  | PanelGroupItem
  | ConversationItem;

/**
 * Почему раздела нет в списке записей. Импортёр провайдера без раздела
 * возвращает пустой список с причиной, а не бросает (П0.2), и причина — из
 * закрытого словаря: её переводит экран.
 */
export const envSkipReasons = [
  'no_section',
  'not_readable',
  'unsupported_format',
  'empty',
  /**
   * Запись в среде есть, но она выключена и потому не действует: выключенное
   * право не лежит в файле настроек, выключенный MCP-сервер лежит в служебном
   * ключе. Паспорт описывает действующую среду, поэтому такая запись названа
   * пропуском, а не увезена как действующая.
   */
  'disabled',
] as const;

export type EnvSkipReason = (typeof envSkipReasons)[number];

export interface EnvSkip {
  readonly kind: EnvItemKind;
  readonly reason: EnvSkipReason;
  /** Подробность для человека: какой файл, какой формат. */
  readonly detail: string;
}

/**
 * Рубильник целого раздела у источника: `disableAllHooks` у Qwen и его аналоги.
 *
 * Едет СОСТОЯНИЕМ, а не пропуском, по двум причинам. Первая: раздел, выключенный
 * рубильником, у источника не работает — значит, и его записи не действуют, и
 * канон обязан привезти их выключенными, иначе перенос ВКЛЮЧАЕТ то, что у
 * человека выключено. Вторая: сам рубильник у цели не щёлкается — он выключил бы
 * заодно её собственные записи, которых перенос не касался. Поэтому состояние
 * доезжает через `enabled: false` каждой записи раздела, а эта строка объясняет
 * человеку, откуда оно взялось.
 */
export interface EnvSectionState {
  readonly kind: EnvItemKind;
  readonly enabled: boolean;
  /** Каким ключом раздел выключен — человек читает это на экране. */
  readonly detail: string;
}

/** Паспорт среды одного провайдера на одном уровне. */
export interface AgentEnvironment {
  readonly canonVersion: CanonVersion;
  readonly provider: string;
  readonly scope: EnvScope;
  /** Корень, от которого собран паспорт: дом провайдера или каталог проекта. */
  readonly root: string;
  readonly capturedAt: string;
  readonly items: readonly EnvItem[];
  readonly skipped: readonly EnvSkip[];
  /** Рубильники разделов источника; пустой список — ни один раздел не выключен целиком. */
  readonly sectionStates: readonly EnvSectionState[];
}

/** Почему паспорт нечитаем: словарь для сообщения человеку, а не строка в домене. */
export type CanonVersionVerdict =
  | { readonly readable: true }
  | { readonly readable: false; readonly reason: 'older_canon' | 'newer_canon' | 'not_a_canon' };

/**
 * Совпадает ли версия паспорта с текущим словарём. Разные версии — не «почти
 * то же самое»: поля могли сменить смысл, и молча прочитанный старый паспорт
 * дал бы перенос, которого человек не заказывал.
 *
 * Второй параметр — не удобство вызывающего: словарь пока первой версии, и без
 * него ветка «паспорт старше» не исполнялась бы ни разу до появления второй.
 * Проверка, которая не может покраснеть, — украшение, поэтому сравнение здесь
 * чистое, а `CANON_VERSION` — всего лишь его значение по умолчанию.
 */
export function checkCanonVersion(
  version: unknown,
  against: number = CANON_VERSION,
): CanonVersionVerdict {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { readable: false, reason: 'not_a_canon' };
  }
  if (version === against) return { readable: true };
  return { readable: false, reason: version < against ? 'older_canon' : 'newer_canon' };
}

/** Требования записи строкой — часть отпечатка и часть показа человеку. */
function needsSignature(needs: EnvNeeds): string {
  return needs.resolution === 'facts'
    ? `facts:${[...needs.facts].sort().join(',')}:${needs.evidence}`
    : needs.resolution;
}

/**
 * СОДЕРЖИМОЕ записи в отпечатке. Без него отпечаток не менялся от правки тела
 * правила, команды хука или текста инструкций — то есть ровно от того, ради
 * обнаружения чего он существует (инвариант 7, «человек правил файл цели
 * руками»): подписка переписала бы правку молча.
 *
 * Происхождение (`source`) в подпись не входит: путь машинно-зависим, а вопрос
 * здесь — изменилось ли ТО, ЧТО записано, а не где оно лежит.
 */
function contentSignature(item: EnvItem): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(item as unknown as Record<string, unknown>)) {
    if (key === 'source' || value === undefined) continue;
    parts.push(`${key}=${stableString(value)}`);
  }
  return parts.sort().join('');
}

/**
 * Значение строкой, не зависящей от порядка ключей. Свой обход, а не
 * `JSON.stringify`: у него порядок ключей объекта — порядок вставки, то есть
 * порядок разбора файла, и отпечаток плыл бы от него.
 */
function stableString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableString(nested)}`)
    .join(',')}}`;
}

/**
 * Детерминированный вход отпечатка среды. Хеш считает вызывающий (здесь нет
 * импортов, значит нет и crypto) — этому модулю принадлежит ровно одно:
 * ВЕРСИЯ КАНОНА стоит первой строкой, поэтому её смена меняет отпечаток любого
 * паспорта, и подписка обязана это заметить.
 *
 * Порядок записей не влияет: строки сортируются, иначе перечитывание одного и
 * того же дома давало бы разный отпечаток от порядка файлов в каталоге.
 */
export function canonFingerprintInput(env: AgentEnvironment): string {
  const head = `canon:${env.canonVersion}\nprovider:${env.provider}\nscope:${env.scope}\nroot:${env.root}`;
  const lines = env.items
    .map(
      (item) =>
        `${item.kind}\t${item.id}\t${item.blocking}\t${needsSignature(item.needs)}\t${[...item.sideEffects].sort().join(',')}\t${contentSignature(item)}`,
    )
    .sort();
  const skipped = env.skipped.map((skip) => `skip\t${skip.kind}\t${skip.reason}`).sort();
  // Рубильник раздела — часть среды: дом, у которого хуки выключены целиком, и
  // дом, у которого они работают, различаются в том числе этим, а отпечаток
  // существует ровно ради «то же самое или уже нет».
  const states = env.sectionStates
    .map((state) => `state\t${state.kind}\t${state.enabled ? 'on' : 'off'}`)
    .sort();
  return [head, ...lines, ...skipped, ...states].join('\n');
}
