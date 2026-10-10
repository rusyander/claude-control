/**
 * Интеграции в прежнем виде — единственное место, где этот вид ещё узнаётся.
 *
 * До 10.10.2026 Jira и Confluence жили одной карточкой `atlassian` (второй
 * адрес и второй ключ — полями внутри неё), GitHub и GitLab — одной `forge` с
 * выбором вида, системы тест-кейсов — одной `tms`. Теперь каждая система —
 * своя интеграция (`integrations.ts`). Настройки, записанные раньше, лежат на
 * диске (`state.json`) и в снимках с других машин; без переезда человек после
 * обновления увидел бы пустые карточки на месте рабочей связи.
 *
 * Ключи переезжают тоже, но их переносит сервер (`lib/app-store`): здесь
 * только список «откуда → куда», потому что вид прежнего форджа и прежней
 * системы тест-кейсов знает только старая настройка, а её загрузка снимает.
 */

/** Перенос одного ключа: получателей несколько у прежнего ключа Atlassian. */
export interface LegacyTokenMove {
  from: string;
  to: string[];
}

export interface LegacyIntegrationsMigration {
  integrations: unknown;
  health: unknown;
  tokens: LegacyTokenMove[];
  /** Было ли что переписывать: загрузка по нему решает, писать ли файл. */
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const deploymentOf = (value: unknown): '' | 'cloud' | 'server' =>
  value === 'cloud' || value === 'server' ? value : '';

const FORGE_KINDS = ['github', 'gitlab'] as const;
const TMS_KINDS = ['zephyr', 'xray', 'testit'] as const;

function kindOf<K extends string>(value: unknown, kinds: readonly K[]): K | undefined {
  return kinds.find((kind) => kind === value);
}

/**
 * Прежние карточки → нынешние. Уже записанная нынешняя карточка не
 * перезаписывается: снимок, в котором есть обе формы, сохранён новой версией,
 * и правда в нынешней. Повторный запуск ничего не находит и ничего не пишет.
 */
export function migrateLegacyIntegrations(
  integrations: unknown,
  health?: unknown,
): LegacyIntegrationsMigration {
  const unchanged = { integrations, health, tokens: [], changed: false };
  if (!isRecord(integrations)) return unchanged;
  if (!('atlassian' in integrations || 'forge' in integrations || 'tms' in integrations)) {
    return unchanged;
  }

  const { atlassian, forge, tms, ...rest } = integrations;
  const next: Record<string, unknown> = { ...rest };
  const tokens: LegacyTokenMove[] = [];
  const healthMoves: [string, string][] = [];

  if (isRecord(atlassian)) {
    const baseUrl = text(atlassian.baseUrl).trim();
    const email = text(atlassian.email);
    const deployment = deploymentOf(atlassian.deployment);
    const enabled = atlassian.enabled === true;
    // Облако держит вики под `/wiki` того же сайта — прежняя карточка
    // достраивала этот путь сама, нынешняя хранит адрес вики целиком.
    const cloud = deployment === 'cloud' || (!deployment && Boolean(email.trim()));
    const wiki =
      text(atlassian.confluenceUrl).trim() ||
      (baseUrl && cloud ? `${baseUrl.replace(/\/+$/, '')}/wiki` : baseUrl);
    next.jira ??= { enabled, baseUrl, email, deployment };
    next.confluence ??= { enabled, baseUrl: wiki, email, deployment };
    // Отдельный ключ Confluence — первым: перенос не перезаписывает уже
    // занятое место, и ключ Jira встаёт в Confluence только когда своего нет.
    tokens.push({ from: 'int:atlassian-confluence', to: ['int:confluence'] });
    tokens.push({ from: 'int:atlassian', to: ['int:jira', 'int:confluence'] });
    healthMoves.push(['int:atlassian', 'int:jira']);
  }

  if (isRecord(forge)) {
    const kind = kindOf(forge.kind, FORGE_KINDS);
    if (kind) {
      next[kind] ??= {
        enabled: forge.enabled === true,
        baseUrl: text(forge.baseUrl),
        repo: text(forge.repo),
      };
      tokens.push({ from: 'int:forge', to: [`int:${kind}`] });
      healthMoves.push(['int:forge', `int:${kind}`]);
    }
  }

  if (isRecord(tms)) {
    const kind = kindOf(tms.kind, TMS_KINDS);
    if (kind) {
      next[kind] ??= {
        enabled: tms.enabled === true,
        baseUrl: text(tms.baseUrl),
        projectKey: text(tms.projectKey),
        groupId: text(tms.groupId),
      };
      tokens.push({ from: 'int:tms', to: [`int:${kind}`] });
      healthMoves.push(['int:tms', `int:${kind}`]);
    }
  }

  let nextHealth = health;
  if (isRecord(health)) {
    const moved: Record<string, unknown> = { ...health };
    for (const [from, to] of healthMoves) {
      if (moved[from] !== undefined && moved[to] === undefined) moved[to] = moved[from];
    }
    for (const from of ['int:atlassian', 'int:forge', 'int:tms']) delete moved[from];
    nextHealth = moved;
  }

  return { integrations: next, health: nextHealth, tokens, changed: true };
}
