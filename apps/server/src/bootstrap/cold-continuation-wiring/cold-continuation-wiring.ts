import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  coldResumeNotice,
  continuationIntro,
  decideContinuation,
} from '../../domains/chat/cold-continuation/cold-continuation.ts';
import { withoutGroupIdentity } from '../../domains/chat/panel-preamble.ts';
import {
  onLegacyStageScheme,
  STAGE_SCHEME_LINE,
  upgradedLink,
} from '../../domains/chat/stage-scheme/stage-scheme.ts';
import type { AppStore } from '../../lib/app-store/store.ts';

export interface ColdContinuationDeps {
  store: Pick<AppStore, 'getChatLink' | 'setChatLink' | 'getSettings' | 'getSplitPlan'>;
  /** Каталог транскриптов CLI (`projects`) — на каждом старте: каталог конфига меняется на лету. */
  projectsDir: () => string;
  /** Последний пинг тёплого кэша сессии (`keep-warm`); нет — сессию не грели. */
  warmedAt?: (sessionId: string) => number | undefined;
  now?: () => number;
}

/**
 * Правило «остывшую сессию группы не продолжать» — на каждом старте реестра
 * (F-05 ревью П1, директива §L4). Группа — разговор со связью к родителю (то же
 * правило, что у `setChildResolver`); обычный чат правило не трогает. Новый
 * разговор получает вводную панели и задание своей стадии из связи, а человек —
 * заметку в ленте.
 *
 * Здесь же — одна точка для всех продолжений — задание дерева, выданное до
 * смены схемы стадий, переводится на нынешнюю (`stage-scheme.ts`) и
 * сохраняется в связи: новый разговор получает нынешнее задание, тёплая сессия —
 * строку о смене схемы первой строкой продолжения, один раз.
 */
export function wireColdContinuation(
  runs: Pick<ChatRunRegistry, 'setContinuationPolicy'>,
  deps: ColdContinuationDeps,
): void {
  const now = deps.now ?? Date.now;
  runs.setContinuationPolicy((keys, options, meta) => {
    const found = keys
      .map((key) => ({ key, link: deps.store.getChatLink(key) }))
      .find((item) => item.link?.parentChatId);
    if (!found?.link || !options.sessionId) return undefined;
    const legacy = onLegacyStageScheme(found.link);
    const link = legacy ? upgradedLink(found.link) : found.link;
    if (legacy) deps.store.setChatLink(found.key, link);
    const plan = deps.store.getSplitPlan(link.parentChatId);
    const group = plan?.groups.find((item) => item.index === link.groupIndex);
    // Группа ждала сброса лимита (§L8): ждали до `resetsAt`, кэш остыл при
    // любом простое. Отметка ещё стоит — снимает её старт этого же хода.
    const waitedLimit = group?.status === 'awaiting' && group.waitingFor === 'limit';
    const warmedAt = deps.warmedAt?.(options.sessionId);
    const decided = decideContinuation({
      dir: deps.projectsDir(),
      sessionId: options.sessionId,
      cwd: options.cwd,
      economy: deps.store.getSettings().groupEconomy,
      intro: continuationIntro(link, plan),
      ...(group?.base ? { base: group.base } : {}),
      afterLimit: Boolean(meta.afterLimit) || waitedLimit,
      ...(warmedAt !== undefined ? { warmedAt } : {}),
      now: now(),
    });
    if (decided.kind === 'resume') {
      return legacy
        ? { options: { ...options, prompt: `${STAGE_SCHEME_LINE}\n\n${options.prompt}` }, meta }
        : undefined;
    }
    // Ответвление (`fork`) — от продолжаемой сессии; без неё ему не от чего идти.
    const { sessionId: _resumed, fork: _fork, ...fresh } = options;
    const { sessionId: _metaSession, ...freshMeta } = meta;
    // Вводная группы сама называет ветку и задачи — строка ветки панели их повторила бы.
    const prompt = withoutGroupIdentity(options.prompt, decided.brief);
    return {
      options: { ...fresh, prompt: `${decided.brief}\n\n${prompt}` },
      meta: freshMeta,
      notice: coldResumeNotice(decided.previous, decided.contextTokens),
    };
  });
}
