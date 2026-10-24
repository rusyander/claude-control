import type { InboxLaunch, InboxSource } from '@agentdeck/contracts/chat-inbox';

/**
 * Строка «чей вопрос» над карточкой: приложение и CLI, фоновый ли ход, группа
 * разделения со стадией. Вдали от стола человек по ней узнаёт, кто его ждёт, не
 * открывая чата. У запуска агента — что поручено, каким агентом, на какой
 * модели и с каким усилием.
 *
 * Тексты здесь, а не в общем словаре: строка собирается из частей по-разному в
 * двух языках, и сборка с её словами — одно место.
 */

type Lang = 'ru' | 'en';

const TEXTS = {
  ru: {
    panel: 'панель',
    outside: 'вне панели',
    background: 'фоновый ход',
    group: (index: number) => `Группа ${index}`,
    stage: (stage: string) => `стадия «${stage}»`,
    from: (title: string) => `из «${title}»`,
    stages: { work: 'работа', review: 'ревью', deliver: 'доставка', fix: 'правки' } as Record<
      string,
      string
    >,
    launch: 'Запуск агента',
    agent: (type: string) => `агент ${type}`,
    model: (model: string) => `модель ${model}`,
    effort: (effort: string) => `усилие ${effort}`,
    inBackground: 'в фоне',
  },
  en: {
    panel: 'panel',
    outside: 'outside the panel',
    background: 'background turn',
    group: (index: number) => `Group ${index}`,
    stage: (stage: string) => `stage “${stage}”`,
    from: (title: string) => `from “${title}”`,
    stages: { work: 'work', review: 'review', deliver: 'delivery', fix: 'fixes' } as Record<
      string,
      string
    >,
    launch: 'Agent launch',
    agent: (type: string) => `agent ${type}`,
    model: (model: string) => `model ${model}`,
    effort: (effort: string) => `effort ${effort}`,
    inBackground: 'in background',
  },
} as const;

/** «Claude Code · панель · фоновый ход». */
export function sourceLine(source: InboxSource | undefined, lang: Lang): string | undefined {
  if (!source) return undefined;
  const t = TEXTS[lang];
  return [
    source.cli,
    source.app === 'outside' ? t.outside : t.panel,
    source.background ? t.background : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** «Группа 2 «Тесты» · стадия «ревью» · из «Задача»». */
export function groupLine(source: InboxSource | undefined, lang: Lang): string | undefined {
  const group = source?.group;
  if (!group) return undefined;
  const t = TEXTS[lang];
  const head = group.title
    ? `${t.group(group.index)} ${lang === 'ru' ? `«${group.title}»` : `“${group.title}”`}`
    : t.group(group.index);
  return [
    head,
    group.stage ? t.stage(t.stages[group.stage] ?? group.stage) : '',
    group.parentTitle ? t.from(group.parentTitle) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Подробности запуска агента: заголовок, что поручено, чем. */
export function launchLines(
  launch: InboxLaunch | undefined,
  lang: Lang,
): { title: string; description?: string; how?: string } | undefined {
  if (!launch) return undefined;
  const t = TEXTS[lang];
  const how = [
    launch.subagentType ? t.agent(launch.subagentType) : '',
    launch.model ? t.model(launch.model) : '',
    launch.effort ? t.effort(launch.effort) : '',
    launch.background ? t.inBackground : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title: t.launch,
    ...(launch.description ? { description: launch.description } : {}),
    ...(how ? { how } : {}),
  };
}
