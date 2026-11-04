import type { SandboxKind } from '@entities/Sandbox';

/**
 * Готовый запрос для проверки конкретной настройки.
 *
 * Общая подсказка вроде «какие скиллы тебе доступны» проверяет не скилл,
 * а сам факт, что список скиллов существует. Настоящая проверка должна
 * бить в то, ради чего настройка написана, — поэтому запрос собирается из
 * неё самой: у скилла в описании прямо сказано, когда его применять,
 * у хука есть событие и фильтр, у правила — его текст.
 */

export interface TestContext {
  title: string;
  /** Описание скилла: обычно «Use КОГДА …» — готовое условие срабатывания. */
  description?: string;
  /** Текст правила. */
  body?: string;
  event?: string;
  matcher?: string;
  /** Первый инструмент MCP-сервера. */
  toolName?: string;
}

export interface TestPrompt {
  /** Короткая подпись на чипе. */
  label: string;
  /** Полный текст, который вставляется в поле запроса. */
  prompt: string;
}

/**
 * Перевод ключа из `sandboxPrompts.*` (`shared/config/i18n/sandbox-prompts`). Подпись и запрос — на
 * языке интерфейса: человек читает запрос в поле и правит его перед отправкой.
 */
export type PromptText = (key: string, params?: Record<string, string>) => string;

export function buildTestPrompts(
  kind: SandboxKind,
  context: TestContext,
  t: PromptText,
): TestPrompt[] {
  switch (kind) {
    case 'skill':
      return skillPrompts(context, t);
    case 'rule':
      return rulePrompts(context, t);
    case 'hook':
    case 'script':
      return hookPrompts(context, t);
    case 'mcp':
      return mcpPrompts(context, t);
    case 'group':
      return groupPrompts(context, t);
    default:
      return [];
  }
}

/** Чип: подпись `<key>Label`, запрос `<key>` с теми же параметрами. */
const chip = (t: PromptText, key: string, params?: Record<string, string>): TestPrompt => ({
  label: t(`${key}Label`, params),
  prompt: t(key, params),
});

/**
 * У скилла описание отвечает на вопрос «когда применять» — из него и делаем
 * задачу. Второй запрос проверяет обратное: что скилл вообще виден Claude.
 */
function skillPrompts({ title, description }: TestContext, t: PromptText): TestPrompt[] {
  const trigger = cleanTrigger(description);

  return [
    {
      label: t('skill.triggerLabel'),
      prompt: trigger
        ? t('skill.triggerWith', { trigger: t('skill.triggerTask', { text: trigger }) })
        : t('skill.triggerWithout', { title }),
    },
    chip(t, 'skill.visible', { title }),
    chip(t, 'skill.review', { title }),
  ];
}

/**
 * Правила бывают запрещающие и предписывающие. Первый запрос провоцирует
 * правило проявиться, второй проверяет, что Claude о нём вообще знает.
 */
function rulePrompts({ title, body }: TestContext, t: PromptText): TestPrompt[] {
  return [
    chip(t, 'rule.provoke', { provocation: provocationFor(title, body, t) }),
    chip(t, 'rule.knows', { title }),
    chip(t, 'rule.plain'),
  ];
}

/** Для хука важно событие: под него и подбирается действие. */
function hookPrompts({ event, matcher }: TestContext, t: PromptText): TestPrompt[] {
  const tool = (matcher ?? '').split('|')[0]?.trim();

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (tool === 'Write' || tool === 'Edit') {
      // Выдуманный ключ GitLab: хук секретов на записи должен его поймать.
      const demoToken = 'glpat-x7Kd93mQpL2vRnT4wZbA';
      return [chip(t, 'hook.write', { token: demoToken }), chip(t, 'hook.safeEdit')];
    }

    return [chip(t, 'hook.danger'), chip(t, 'hook.git'), chip(t, 'hook.safe')];
  }

  if (event === 'UserPromptSubmit') return [chip(t, 'hook.link')];

  // События вроде SessionStart и Stop срабатывают сами; проверяем по следам
  // в ответе, а не по действию пользователя.
  return [chip(t, 'hook.context')];
}

function mcpPrompts({ title, toolName }: TestContext, t: PromptText): TestPrompt[] {
  return [
    chip(t, 'mcp.list', { title }),
    toolName ? chip(t, 'mcp.callNamed', { tool: toolName }) : chip(t, 'mcp.callAny', { title }),
  ];
}

function groupPrompts({ title }: TestContext, t: PromptText): TestPrompt[] {
  return [chip(t, 'group.loaded', { title }), chip(t, 'group.conflicts'), chip(t, 'group.danger')];
}

/**
 * Описание скилла начинается со служебного «Use КОГДА …» — вырезаем этот
 * зачин и оставляем сам случай, чтобы получилась задача, а не пересказ.
 */
function cleanTrigger(description?: string): string {
  if (!description) return '';

  const text = description
    .replace(/^use\s+(когда|when)\s*/i, '')
    .replace(/^когда\s*/i, '')
    .split(/[—–]\s*ЛИБО|\bЛИБО\b/i)[0]
    ?.trim();

  if (!text || text.length < 12) return '';

  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/**
 * Провокации правил по порядку проверки: первая, чей образец нашёлся в заголовке или тексте
 * правила, и даёт запрос.
 */
const PROVOCATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/git|коммит|commit|push|merge/, 'git'],
  [/удал|delete|rm\s|разрушительн/, 'delete'],
  [/секрет|token|ключ|пароль/, 'secret'],
  [/бэкенд|backend|бд|база данных|миграц/, 'backend'],
  [/язык|русск|english/, 'language'],
  [/скрин|screenshot|before|after/, 'screenshot'],
];

/**
 * Запрос, на котором правило должно себя показать. Запрещающие правила
 * проверяются попыткой сделать запрещённое, остальные — обычной работой,
 * в которой предписание проявится.
 */
function provocationFor(title: string, body: string | undefined, t: PromptText): string {
  const text = `${title} ${body ?? ''}`.toLowerCase();
  const found = PROVOCATIONS.find(([pattern]) => pattern.test(text));
  return found ? t(`rule.provocation.${found[1]}`) : t('rule.provocation.other', { title });
}
