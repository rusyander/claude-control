import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SkillDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { slugify } from '../../lib/slug.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { assertSkillId, disabledSkillsDir } from './paths.ts';

/** Имя нового скилла уже занято — маршрут отвечает 409, а не пишет поверх. */
export class SkillExistsError extends Error {
  readonly skillId: string;

  constructor(skillId: string, isDisabled: boolean) {
    // Текст уходит человеку в тост: «сейчас выключен» — только когда это правда,
    // иначе про включённый скилл сообщалось бы, что он выключен.
    super(`Скилл «${skillId}» уже существует${isDisabled ? ' и сейчас выключен' : ''}`);
    this.name = 'SkillExistsError';
    this.skillId = skillId;
  }
}

export function saveSkill(
  skillsDir: string,
  skillId: string | null,
  draft: SkillDraft,
  backupDir?: string,
): string | undefined {
  // Слаг безопасен по построению; явный id пришёл из адреса — проверяем.
  const id = skillId === null ? slugifyName(draft.name) : assertSkillId(skillId);

  // Выключенный скилл физически лежит в skills-disabled/. Запись правки в
  // skills/ создала бы вторую, включённую копию: панель по-прежнему считает
  // скилл выключенным, а Claude его уже видит. Поэтому пишем туда, где скилл
  // лежит сейчас, — правка не меняет состояние включённости.
  const disabledDir = disabledSkillsDir(skillsDir);
  const livesDisabled = !existsSync(join(skillsDir, id)) && existsSync(join(disabledDir, id));

  // СОЗДАНИЕ с занятым слагом — отказ, а не запись поверх: иначе новый черновик
  // затёр бы чужой скилл. Занят он выключенным (лежит в skills-disabled/, и
  // «созданный» скилл оказался бы сразу выключенным) или включённым — разницы
  // нет, теряется чужая работа. Слаги совпадают чаще, чем кажется: имена
  // режутся до 60 символов, так что «…руководство по стилю, часть первая» и
  // «…часть вторая» дают один и тот же id.
  if (skillId === null && (livesDisabled || existsSync(join(skillsDir, id))))
    throw new SkillExistsError(id, livesDisabled);

  const base = livesDisabled ? disabledDir : skillsDir;
  const skillDir = join(base, id);
  mkdirSync(skillDir, { recursive: true });

  const skillFile = join(skillDir, 'SKILL.md');

  // Шапку пересобираем поверх лежащей на диске: allowed-tools, model, license
  // форма не знает, а молча их стереть — потеря данных в живом ~/.claude.
  // Сериализуем тем же yaml, которым разбираем: значение с двоеточием,
  // кавычками или переводом строки он закавычит сам. Собранная руками строка
  // такие значения ломала, и Claude Code переставал читать name/description.
  const existing = existsSync(skillFile)
    ? splitFrontmatter(readTextFile(skillFile)).frontmatter
    : {};
  const header: Record<string, unknown> = { name: draft.name, description: draft.description };
  for (const [key, value] of Object.entries(existing)) {
    if (key !== 'name' && key !== 'description') header[key] = value;
  }

  // lineWidth: 0 — иначе длинное описание сложится в несколько строк, и
  // запасной построчный разбор шапки увидит от него только первую.
  const frontmatter = `---\n${stringifyYaml(header, { lineWidth: 0 })}---`;

  // Пустой скилл бесполезен: без инструкций Claude нечего исполнять.
  // Поэтому вместо пустого файла кладём каркас с подсказками по разделам.
  const body = draft.body.trim() || buildSkillTemplate(draft.name);
  const content = `${frontmatter}\n\n${body}\n`;

  return writeTextFile(skillFile, content, { backupDir });
}

/** Каркас нового скилла: структура, которую потом остаётся наполнить. */
function buildSkillTemplate(name: string): string {
  return `# ${name}

## Когда применять

Опишите ситуацию, в которой этот скилл нужен. Поле description в шапке решает,
подключит ли Claude скилл вообще, а этот раздел уточняет границы применения.

## Что делать

1. Первый шаг.
2. Второй шаг.
3. Что считать результатом.

## Чего не делать

Явные запреты и типичные ошибки — их полезно перечислить отдельно.

## Как проверить результат

Команда, тест или признак, по которому видно, что работа сделана правильно.`;
}

/**
 * Имя папки скилла из имени, введённого человеком.
 *
 * Слаг общий с правилами (`lib/slug.ts`), потому что здесь он не украшение, а
 * путь на диске: до транслитерации русское имя («Проверка кода») давало пустую
 * строку, `join(skillsDir, '')` указывал на САМ каталог skills/, и панель
 * писала `skills/SKILL.md` — скилл не появлялся в списке, а следующее такое же
 * имя молча затирало этот файл.
 *
 * Из имени вообще без букв и цифр (иероглифы, только эмодзи) слага не выйдет —
 * тогда отказываем с внятным текстом, а не пишем непонятно куда. `statusCode`
 * читает Fastify: маршрут отвечает 400, а не 500.
 */
function slugifyName(name: string): string {
  const id = slugify(name);
  if (id) return id;

  throw Object.assign(
    new Error(
      'Из имени не получается имя папки. Добавьте в название латиницу, кириллицу или цифры.',
    ),
    { statusCode: 400, code: 'invalid_name' },
  );
}
