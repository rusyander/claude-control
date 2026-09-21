import type {
  CommandItem,
  EnvItemKind,
  EnvSkip,
  EnvVarItem,
  InstructionsItem,
  PluginForm,
  PluginItem,
  SecretItem,
  SkillItem,
  SubagentItem,
} from '@agentdeck/contracts/portable-env';
import { isSecretName } from '../../lib/secret-mask.ts';
import {
  envItemId,
  envSkip,
  maskSecret,
  needsFacts,
  needsNone,
  needsUndetermined,
} from './canon.ts';
import { expandInstructionImports } from './instruction-imports.ts';
import type { EnvSourceFactory } from './normalize-types.ts';
import { readSkillAttachments, type SkillAttachments } from './skill-attachments.ts';
import type { ParsedSubagent } from './subagents.ts';

/**
 * Файловые разделы → канон: инструкции, скиллы, команды, субагенты, плагины,
 * переменные и секреты.
 *
 * Общее у всех: `needs` называется вслух. Текст, который читает модель, рантайма
 * не требует — и это УТВЕРЖДЕНИЕ, а не пустой массив; плагин, содержимое
 * которого разбирается отдельной волной, требований не знает — и это
 * `undetermined`, а не «ничего не нужно».
 */

/** Инструкции одного файла: `@`-импорты раскрыты, карта источников сохранена. */
export function instructionsItem(params: {
  source: EnvSourceFactory;
  filePath: string;
  fileName: string;
  legacy: boolean;
  raw: string;
  /** Действует ли запись; у файла — всегда да, у правила — его состояние в панели. */
  enabled?: boolean;
  /**
   * Готовый текст вместо раскрытия файла: так приезжает ОДИН раздел
   * `## ПРАВИЛО:` — файл у него общий, а текст свой.
   */
  content?: { text: string; includes: readonly string[]; problems?: readonly string[] };
  /**
   * Куда сложить нераскрытые импорты. Цикл и превышение глубины обязаны дойти до
   * человека пропуском с именем файла: молча собранный текст без куска инструкций
   * — это перенос, который увёз не то.
   */
  skips?: EnvSkip[];
}): InstructionsItem {
  const expanded = params.content ?? expandInstructionImports(params.filePath);
  // Проблемы раскрытия едут и с готовым текстом: нераскрытый импорт внутри
  // одного правила — такая же потеря, как и в целом файле.
  for (const problem of expanded.problems ?? []) {
    params.skips?.push(envSkip('instructions', 'not_readable', `${params.fileName}: ${problem}`));
  }
  return {
    id: envItemId('instructions', params.fileName),
    kind: 'instructions',
    source: params.source('file', params.filePath),
    intent: `файл инструкций ${params.fileName}: его текст читает модель в каждом разговоре`,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: needsNone('текст инструкций читает модель; фактов рантайма ему не нужно'),
    sideEffects: ['changes_prompt'],
    fileName: params.fileName,
    text: expanded.text,
    // Карта «откуда что пришло»: сам файл плюс всё, что в него раскрылось.
    includes: [...expanded.includes],
    legacy: params.legacy,
    enabled: params.enabled ?? true,
    raw: params.raw,
  };
}

/** Скилл: каталог с `SKILL.md` либо запись без файла (синхронизация с аккаунтом). */
export function skillItem(params: {
  source: EnvSourceFactory;
  name: string;
  description: string;
  body: string;
  dir: string | null;
  enabled: boolean;
  /** Происхождение, когда файл на диске есть, но владеет им аккаунт (`skills/synced/`). */
  origin?: 'file' | 'account';
  raw: string;
}): SkillItem {
  // Опись поддерева читается ЗДЕСЬ, у единственного сборщика записи: делать это
  // в каждом импортёре значило бы иметь столько правил потолка, сколько у нас
  // читателей скиллов, и скилл, приехавший от одного CLI, вёз бы справку, а от
  // другого — нет.
  const subtree = readSkillAttachments(params.dir);
  // Скилла без файла на диске быть может (2.1.275, синхронизация с аккаунтом), и
  // тогда происхождение — аккаунт, а не пустое тело. Эмиттер по этому признаку
  // выдаст `×` с причиной, а не запишет цели пустой скилл.
  const origin = params.origin ?? (params.dir === null ? 'account' : 'file');
  return {
    // Владелец входит в имя записи: скилл `demo` в `skills/` и скилл `demo`,
    // синхронизированный с аккаунтом, — ДВЕ разные записи одного дома, а по
    // идентификатору идёт идемпотентный upsert (инвариант 10). С общим ключом
    // одна из них молча затёрла бы другую у цели.
    id: envItemId('skill', origin === 'account' ? `account/${params.name}` : params.name),
    kind: 'skill',
    source: params.source(origin, params.dir),
    intent: intentOfSkill(params.name, params.description, origin, params.dir, subtree),
    trigger: { on: 'model' },
    blocking: 'inapplicable',
    needs: needsNone('скилл выбирает модель по описанию; фактов рантайма ему не нужно'),
    sideEffects: ['changes_prompt'],
    name: params.name,
    description: params.description,
    body: params.body,
    dir: params.dir,
    enabled: params.enabled,
    attachments: subtree.attachments,
    attachmentsSkipped: subtree.skipped,
    raw: params.raw,
  };
}

/**
 * Фраза человеку о скилле. Владелец скилла важнее его описания: синхронизированный
 * с аккаунтом скилл переносится не как файл, и молчать об этом нельзя.
 */
function intentOfSkill(
  name: string,
  description: string,
  origin: 'file' | 'account',
  dir: string | null,
  subtree: SkillAttachments,
): string {
  const owner =
    origin !== 'account'
      ? `скилл ${name}: ${description || 'без описания'}`
      : dir === null
        ? `скилл ${name}: источник — аккаунт, файла на диске нет`
        : `скилл ${name}: синхронизирован с аккаунтом, владелец записи — аккаунт`;
  return `${owner}${subtreeNote(subtree)}`;
}

/**
 * Вложения одной фразой. Непереносимые названы ЧИСЛОМ здесь и поимённо в самой
 * записи: строка паспорта не место для списка файлов, но умолчать о потере
 * нельзя — человек читает паспорт, а не опись.
 */
function subtreeNote(subtree: SkillAttachments): string {
  const parts: string[] = [];
  if (subtree.attachments.length > 0) parts.push(`вложений ${subtree.attachments.length}`);
  if (subtree.skipped.length > 0) parts.push(`не переносится ${subtree.skipped.length}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Подстановка аргументов в теле команды — то, ради чего команде нужен текст запроса. */
const COMMAND_ARGUMENTS = /\$ARGUMENTS|\$\d+(?!\w)|\{\{args\}\}/;

/** Слэш-команда: подкаталог даёт пространство имён (`/dir:name`). */
export function commandItem(params: {
  source: EnvSourceFactory;
  name: string;
  namespace: string | null;
  description: string;
  prompt: string;
  file: string | null;
  raw: string;
}): CommandItem {
  const takesArguments = COMMAND_ARGUMENTS.test(params.prompt);
  return {
    id: envItemId('command', params.namespace ? `${params.namespace}-${params.name}` : params.name),
    kind: 'command',
    source: params.source('file', params.file),
    intent: `команда /${params.namespace ? `${params.namespace}:` : ''}${params.name}: ${params.description || 'без описания'}`,
    trigger: { on: 'user' },
    blocking: 'inapplicable',
    needs: takesArguments
      ? needsFacts(['prompt'], 'declared')
      : needsNone('команда разворачивается в готовый текст и аргументов не берёт'),
    sideEffects: ['changes_prompt'],
    name: params.name,
    namespace: params.namespace,
    description: params.description,
    prompt: params.prompt,
    raw: params.raw,
  };
}

/** Субагент: разбор `~/.claude/agents/*.md` (`subagents.ts`) → запись канона. */
export function subagentItem(source: EnvSourceFactory, parsed: ParsedSubagent): SubagentItem {
  return {
    id: envItemId('subagent', parsed.name),
    kind: 'subagent',
    source: source('file', parsed.filePath),
    intent: `субагент ${parsed.name}: ${parsed.description || 'без описания'}`,
    trigger: { on: 'model' },
    blocking: 'inapplicable',
    needs: needsNone('субагент получает задачу текстом; фактов рантайма ему не нужно'),
    sideEffects: ['changes_prompt'],
    name: parsed.name,
    description: parsed.description,
    tools: parsed.tools,
    model: parsed.model,
    // Поле обязано доехать: субагент с ним работает БЕЗ проектных инструкций, и
    // потерянный флаг даёт субагента с контекстом, которого у него не было.
    omitInstructions: parsed.omitInstructions,
    raw: parsed.raw,
  };
}

/** Плагин как единица; его содержимое разбирается отдельной волной (П2.6). */
export function pluginItem(params: {
  source: EnvSourceFactory;
  name: string;
  version: string | null;
  /** Чем плагин является у источника: решает, переносима ли сама единица. */
  form: PluginForm;
  readOnly: boolean;
  provides: readonly EnvItemKind[];
  file: string | null;
  origin?: 'file' | 'account';
  /** Включён ли плагин; не задан — включён (у разделов без выключателя иначе не скажешь). */
  enabled?: boolean;
  raw: string;
}): PluginItem {
  return {
    id: envItemId('plugin', params.name),
    kind: 'plugin',
    source: params.source(params.origin ?? 'file', params.file),
    intent: `плагин ${params.name}${params.version ? ` ${params.version}` : ''}`,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    // Плагин приносит с собой чужой код и чужие записи; чего он требует от
    // рантайма, знает только его содержимое — а оно разбирается не здесь.
    needs: needsUndetermined(
      'содержимое плагина разбирается отдельно: его требования пока неизвестны',
    ),
    sideEffects: ['runs_process'],
    name: params.name,
    version: params.version,
    form: params.form,
    readOnly: params.readOnly,
    provides: [...params.provides],
    enabled: params.enabled ?? true,
    raw: params.raw,
  };
}

/**
 * Имя ключа выглядит учётной записью — ТЕМ ЖЕ детектором, каким панель решает
 * это везде (`lib/secret-mask.ts`), а не своим выражением.
 *
 * Своё здесь стояло и было уже, и оно было. Требовалось `api_key` или
 * `access_key` целиком, так что `OPENAI_KEY` и `GITHUB_PAT` секретами не
 * считались — и значение такого ключа из `.env` чужого CLI уезжало в канон,
 * в тело маршрута и в результат агента панели открытым текстом. Проверка QA
 * этого не ловила: маркер лежал только в ключах, которые прежнее выражение
 * ловило. Теперь он лежит и в `OPENAI_KEY`, и в `GITHUB_PAT`.
 */
export function looksLikeSecret(key: string): boolean {
  return isSecretName(key.trim());
}

/**
 * Переменная окружения или секрет. Решает ИМЯ ключа: значение секрета в канон не
 * попадает вовсе — у `SecretItem` нет поля, куда его можно было бы положить.
 */
export function envVarOrSecret(params: {
  source: EnvSourceFactory;
  key: string;
  value: string;
  file: string | null;
  holder: SecretItem['holder'];
}): EnvVarItem | SecretItem {
  if (looksLikeSecret(params.key)) {
    return {
      id: envItemId('secret', params.key),
      kind: 'secret',
      source: params.source('file', params.file),
      intent: `ключ ${params.key}: значение остаётся у держателя и в перенос не едет`,
      trigger: { on: 'always' },
      blocking: 'inapplicable',
      needs: needsNone('ключ нужен процессу целиком, фактов разговора ему не требуется'),
      sideEffects: ['reads_secrets'],
      name: params.key,
      mask: maskSecret(params.value),
      holder: params.holder,
    };
  }

  return {
    id: envItemId('envVar', params.key),
    kind: 'envVar',
    source: params.source('file', params.file),
    intent: `переменная окружения ${params.key}`,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: needsNone('переменная окружения действует постоянно и фактов разговора не требует'),
    sideEffects: [],
    name: params.key,
    value: params.value,
    raw: `${params.key}=${params.value}`,
  };
}
