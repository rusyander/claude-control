import type {
  AllowedTriple,
  CompatAdapter,
  CompatAlternative,
  CompatDecision,
  CompatPolicy,
  CompatRoute,
  Dialect,
  ModelFacts,
  RefusalCode,
} from '@agentdeck/contracts/core/routes';

/**
 * Совместимость переходника и маршрута (11 R:PR-05, 00 §Decision classes «adapter × route
 * compatible»): единственный судья класса `compat`. Решает по ВОЗМОЖНОСТЯМ и фактам, никогда по
 * именам — id переходника, маршрута и модели здесь только сравниваются с разрешённым набором и
 * с привязкой входа CLI, а переименование не меняет ни одного решения (P109).
 *
 * Порядок проверок задаёт один код отказа на пару: сначала то, что исправляет только человек
 * (набор, доступ), потом провод (канал, обход, DLP), потом модель и пределы. Отказ несёт
 * годных кандидатов из разрешённого набора — та же функция над каждым (P110); подмены здесь нет.
 */

type Refusal = { code: RefusalCode; setting?: string };
type Verdict = Exclude<CompatDecision, { kind: 'refused' }> | Refusal;

function patternMatches(pattern: string, id: string): boolean {
  if (!pattern.includes('*')) return pattern === id;
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`).test(id);
}

/**
 * Модель тройки под разрешённым шаблоном. Модель по умолчанию CLI (`null`) — имени нет, и CLI
 * может взять любую: её пропускает только шаблон «любая модель» (`*`); `claude-*` или точное имя —
 * нет, выбор CLI мог бы выйти за них.
 */
function modelAllowed(pattern: string, id: string | null): boolean {
  if (id === null) return pattern === '*';
  return patternMatches(pattern, id);
}

function allowedBy(allowed: readonly AllowedTriple[], c: CompatAdapterTriple): boolean {
  return allowed.some(
    (t) =>
      t.adapter === c.adapter.id &&
      t.route === c.route.id &&
      modelAllowed(t.modelPattern, c.model.id),
  );
}

interface CompatAdapterTriple {
  adapter: CompatAdapter;
  route: CompatRoute;
  model: ModelFacts;
}

/** Доступность: `absent` — отказ; `unknown` — отказ только если класс чтения велит отказать. */
function unavailable(route: CompatRoute): boolean {
  const { state, onUnknown } = route.availability;
  return state === 'absent' || (state === 'unknown' && onUnknown === 'refuse');
}

/**
 * Провод для маршрута с адресом: канал на один сеанс, не обойдённый настройкой человека, в
 * диалекте маршрута — напрямую, иначе через перевод звена шлюза.
 */
function wire(adapter: CompatAdapter, route: CompatRoute, policy: CompatPolicy): Verdict {
  const channels = adapter.caps.channels;
  if (channels.length === 0) return { code: 'login_only' };
  // Правка общего файла человека — не канал ядра (11 R:PR-05: файл только свой на сеанс).
  const perSession = channels.filter((channel) => channel.perSession);
  if (perSession.length === 0) return { code: 'no_channel' };
  // Обход неизвестен — отказ: CLI мог бы уйти мимо нашего адреса к облаку вендора (P46).
  const open = perSession.filter(
    (channel) => !channel.bypass || adapter.bypassActive[channel.bypass.setting] === false,
  );
  const blocked = perSession.find((channel) => channel.bypass);
  if (open.length === 0 && blocked?.bypass)
    return { code: 'bypass_setting', setting: blocked.bypass.setting };
  const direct = open.find((channel) => route.caps.dialects.includes(channel.dialect));
  if (direct) return { kind: 'direct', channel: direct };
  for (const channel of open) {
    const to = route.caps.dialects.find((dialect) =>
      canTranslate(policy.translations, channel.dialect, dialect),
    );
    if (to) return { kind: 'via-gateway', channel, from: channel.dialect, to };
  }
  return { code: 'no_channel' };
}

function canTranslate(pairs: CompatPolicy['translations'], from: Dialect, to: Dialect): boolean {
  return pairs.some((pair) => pair.from === from && pair.to === to);
}

/** Диалект, который увидит DLP-звено: тело на участке CLI → звено. */
function dlpDialect(verdict: Exclude<Verdict, Refusal>): Dialect | undefined {
  return verdict.channel.via === 'login' ? undefined : verdict.channel.dialect;
}

function judge(c: CompatAdapterTriple, policy: CompatPolicy): Verdict {
  const { adapter, route, model } = c;
  if (!allowedBy(policy.allowed, c)) return { code: 'not_allowed' };
  if (unavailable(route)) return { code: 'route_unavailable' };
  if (route.credential === 'absent') return { code: 'credential_absent' };
  if (model.served === 'absent') return { code: 'model_absent' };
  const binding = route.caps.binding;
  // Маршруту с адресом нужна модель в адресе: модель по умолчанию CLI ему не годится.
  if (model.id === null && binding.via !== 'cli-login') return { code: 'model_absent' };

  let verdict: Verdict;
  if (binding.via === 'cli-login') {
    // Вход CLI годится только своему CLI; канал адреса тут не нужен.
    verdict =
      binding.adapter === adapter.id
        ? { kind: 'direct', channel: { via: 'login' } }
        : { code: 'no_channel' };
  } else {
    verdict = wire(adapter, route, policy);
  }
  if ('code' in verdict) return verdict;

  if (policy.dlp.required) {
    const dialect = dlpDialect(verdict);
    const parsed = dialect === undefined || policy.dlp.parses.includes(dialect);
    if (!route.caps.maskable || !parsed) return { code: 'dlp_opaque' };
  }
  if (policy.needsTools && (!route.caps.tools || model.tools === false))
    return { code: 'no_tools' };
  if (
    policy.minContextTokens !== undefined &&
    model.contextTokens !== undefined &&
    model.contextTokens < policy.minContextTokens
  )
    return { code: 'context_too_small' };
  if (route.caps.limitsToTell && adapter.caps.limitsChannel === null)
    return { code: 'window_untellable' };
  return verdict;
}

function sameTriple(a: CompatAdapterTriple, b: CompatAdapterTriple): boolean {
  return a.adapter.id === b.adapter.id && a.route.id === b.route.id && a.model.id === b.model.id;
}

export function compat(
  adapter: CompatAdapter,
  route: CompatRoute,
  model: ModelFacts,
  policy: CompatPolicy,
): CompatDecision {
  const triple = { adapter, route, model };
  const verdict = judge(triple, policy);
  if (!('code' in verdict)) return verdict;
  const alternatives: CompatAlternative[] = [];
  for (const candidate of policy.candidates ?? []) {
    if (sameTriple(candidate, triple)) continue;
    // Та же функция над кандидатом, без его собственных кандидатов: альтернатива альтернативы
    // не нужна, а глубина рекурсии ограничена одним шагом.
    const other = compat(candidate.adapter, candidate.route, candidate.model, {
      ...policy,
      candidates: [],
    });
    if (other.kind === 'refused') continue;
    alternatives.push({
      adapter: candidate.adapter.id,
      route: candidate.route.id,
      model: candidate.model.id,
      kind: other.kind,
    });
  }
  return {
    kind: 'refused',
    code: verdict.code,
    ...(verdict.setting !== undefined ? { setting: verdict.setting } : {}),
    alternatives,
  };
}
