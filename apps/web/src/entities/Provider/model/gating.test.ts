import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  type Capability,
  type CapabilityStatus,
  type ProvidersResponse,
} from '@claude-control/contracts';
import { NAV_SECTIONS, NAV_ITEMS } from '@shared/config/navigation';
import {
  gateNavSections,
  navItemAccess,
  activeCapabilities,
  isCapabilityReady,
  summarizeNavCapabilities,
  visibleNavItems,
} from './gating';

/** Собрать карту возможностей: все `unsupported`, перечисленные — заданным статусом. */
function caps(
  overrides: Partial<Record<Capability, CapabilityStatus>>,
): Record<Capability, CapabilityStatus> {
  const map = {} as Record<Capability, CapabilityStatus>;
  for (const capability of CAPABILITIES) map[capability] = overrides[capability] ?? 'unsupported';
  return map;
}

const ALL_READY = caps(Object.fromEntries(CAPABILITIES.map((c) => [c, 'ready'])));

/** Карта codex как на сервере: ready — инструкции/MCP/env/права/проекты/скрипты. */
const CODEX = caps({
  globalInstructions: 'ready',
  mcp: 'ready',
  env: 'ready',
  permissions: 'ready',
  chat: 'planned',
  // COMMON-2: проектный уровень (проектный AGENTS.md + .codex/config.toml).
  projects: 'ready',
  // COMMON-1: скрипты — раздел самой панели, работает у любого провайдера.
  scripts: 'ready',
});

function response(activeId: string): ProvidersResponse {
  return {
    active: activeId,
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        status: 'verified',
        capabilities: ALL_READY,
        instructionsModel: 'file',
      },
      {
        id: 'codex',
        name: 'Codex (OpenAI)',
        status: 'experimental',
        capabilities: CODEX,
        instructionsModel: 'file',
      },
    ],
  };
}

/** Сколько всего пунктов в исходной навигации. */
const TOTAL_ITEMS = NAV_ITEMS.length;

describe('гейтинг навигации по провайдеру', () => {
  it('claude: показаны все 18 разделов, ничего не «в разработке»', () => {
    const gated = gateNavSections(NAV_SECTIONS, ALL_READY);
    const items = gated.flatMap((section) => section.items);
    expect(items).toHaveLength(TOTAL_ITEMS);
    expect(items.every((item) => item.access === 'ready')).toBe(true);
    // Все исходные секции на месте.
    expect(gated.map((section) => section.label)).toEqual(NAV_SECTIONS.map((s) => s.label));
  });

  it('данные ещё не загружены → показываем всё (дефолт Claude, без мигания)', () => {
    const gated = gateNavSections(NAV_SECTIONS, undefined);
    expect(gated.flatMap((section) => section.items)).toHaveLength(TOTAL_ITEMS);
    expect(
      navItemAccess(
        { path: '/hooks', label: 'x', icon: 'hooks', key: 'hooks', capability: 'hooks' },
        undefined,
      ),
    ).toBe('ready');
  });

  it('codex: unsupported-разделы (hooks/plugins/skills/analytics/rules) скрыты', () => {
    const gated = gateNavSections(NAV_SECTIONS, CODEX);
    const paths = gated.flatMap((section) => section.items).map((item) => item.path);
    expect(paths).not.toContain('/hooks');
    expect(paths).not.toContain('/plugins');
    expect(paths).not.toContain('/skills');
    expect(paths).not.toContain('/analytics');
    expect(paths).not.toContain('/rules');
  });

  it('codex: planned-разделы показаны с пометкой «в разработке», mcp/права — готовы', () => {
    const gated = gateNavSections(NAV_SECTIONS, CODEX);
    const items = gated.flatMap((section) => section.items);
    const chat = items.find((item) => item.path === '/chat');
    const permissions = items.find((item) => item.path === '/permissions');
    const mcp = items.find((item) => item.path === '/mcp');
    expect(chat?.access).toBe('inDevelopment');
    // MCP теперь рабочий адаптер (Codex TOML) — раздел ready, не заглушка.
    expect(mcp?.access).toBe('ready');
    // Права/аппрувы (Codex approval_policy/sandbox_mode) — тоже ready.
    expect(permissions?.access).toBe('ready');
    // Переменные окружения (Codex shell_environment_policy.set) — тоже ready.
    const env = items.find((item) => item.path === '/env');
    expect(env?.access).toBe('ready');
  });

  it('codex: панель-level разделы (настройки/история/поиск/обзор/группы/справка) видны всегда', () => {
    const gated = gateNavSections(NAV_SECTIONS, CODEX);
    const paths = gated.flatMap((section) => section.items).map((item) => item.path);
    for (const panelPath of ['/', '/search', '/groups', '/history', '/settings', '/help']) {
      expect(paths).toContain(panelPath);
    }
  });

  it('codex: раздел инструкций (claude-md) готов — заглушки нет', () => {
    const gated = gateNavSections(NAV_SECTIONS, CODEX);
    const claudeMd = gated
      .flatMap((section) => section.items)
      .find((item) => item.path === '/claude-md');
    expect(claudeMd?.access).toBe('ready');
    // Прямая проверка доступа к разделу инструкций у codex.
    expect(
      navItemAccess(
        {
          path: '/claude-md',
          label: 'x',
          icon: 'file',
          key: 'claudeMd',
          capability: 'globalInstructions',
        },
        CODEX,
      ),
    ).toBe('ready');
  });

  it('пустая секция после гейтинга отбрасывается', () => {
    // У codex вся секция «Поведение»: claudeMd и scripts ready остаются,
    // значит секция не пуста. Проверим целиком на провайдере без единого раздела
    // в секции интеграций.
    const noIntegrations = caps({ chat: 'planned' });
    const gated = gateNavSections(NAV_SECTIONS, noIntegrations);
    // Секция интеграций (mcp/permissions/env/projects) целиком unsupported → её нет.
    expect(gated.map((s) => s.label)).not.toContain('nav.sectionIntegrations');
  });

  it('смена активного провайдера меняет набор, возврат к claude восстанавливает всё', () => {
    const onCodex = activeCapabilities(response('codex'));
    expect(visibleNavItems(NAV_ITEMS, onCodex).map((i) => i.path)).not.toContain('/hooks');

    const onClaude = activeCapabilities(response('claude'));
    expect(visibleNavItems(NAV_ITEMS, onClaude)).toHaveLength(TOTAL_ITEMS);
  });

  it('activeCapabilities возвращает карту активного провайдера', () => {
    expect(activeCapabilities(response('codex'))?.chat).toBe('planned');
    expect(activeCapabilities(response('claude'))?.chat).toBe('ready');
    expect(activeCapabilities(undefined)).toBeUndefined();
  });
});

/**
 * Точечный гейт элемента внутри общей страницы (COMMON-1): «Скрипты» открыты
 * всем провайдерам, но песочница и отметка «вызывается хуком» — только там, где
 * такие возможности реально есть.
 */
describe('isCapabilityReady — гейт элемента на общей странице', () => {
  it('claude: true без ожидания карты (быстрый путь, поведение прежнее)', () => {
    expect(isCapabilityReady('claude', undefined, 'sandbox')).toBe(true);
    expect(isCapabilityReady(undefined, undefined, 'hooks')).toBe(true);
  });

  it('не-claude без карты: false (fail-closed, не мигаем чужим элементом)', () => {
    expect(isCapabilityReady('codex', undefined, 'sandbox')).toBe(false);
  });

  it('codex: скрипты готовы, песочница и хуки — нет', () => {
    const data = response('codex');
    expect(isCapabilityReady('codex', data, 'scripts')).toBe(true);
    expect(isCapabilityReady('codex', data, 'sandbox')).toBe(false);
    expect(isCapabilityReady('codex', data, 'hooks')).toBe(false);
  });
});

describe('сводка возможностей для селектора', () => {
  it('claude: все навигационные разделы готовы', () => {
    const summary = summarizeNavCapabilities(ALL_READY);
    expect(summary.planned).toBe(0);
    expect(summary.unsupported).toBe(0);
    expect(summary.ready).toBeGreaterThan(0);
  });

  it('codex: 6 готовы (инструкции + MCP + env + права + проекты + скрипты), 1 в разработке', () => {
    const summary = summarizeNavCapabilities(CODEX);
    expect(summary.ready).toBe(6);
    expect(summary.planned).toBe(1);
  });
});

/** Ф8 + COMMON-2 + CURSOR-1: карты cursor и opencode как на сервере. */
const CURSOR = caps({
  // CURSOR-1: правила Cursor — КАТАЛОГ `~/.cursor/rules/*.mdc` (третья модель
  // раздела инструкций), формат подтверждён документацией → ready.
  globalInstructions: 'ready',
  mcp: 'ready',
  // COMMON-2 + CURSOR-1: проектный уровень — `.cursor/mcp.json` и `.cursor/rules`.
  projects: 'ready',
  scripts: 'ready',
});
const OPENCODE = caps({
  globalInstructions: 'ready',
  mcp: 'ready',
  permissions: 'planned',
  env: 'planned',
  chat: 'planned',
  // COMMON-2: проектный AGENTS.md + <проект>/opencode.json.
  projects: 'ready',
  scripts: 'ready',
  skills: 'planned',
  hooks: 'planned',
  plugins: 'planned',
});
/** У aider из чужих форматов рабочих разделов нет — только скрипты самой панели. */
const AIDER = caps({
  globalInstructions: 'planned',
  env: 'planned',
  chat: 'planned',
  scripts: 'ready',
});

describe('Ф8: гейтинг cursor / opencode / aider', () => {
  it('cursor: MCP и правила-каталог — рабочие разделы (CURSOR-1)', () => {
    const items = gateNavSections(NAV_SECTIONS, CURSOR).flatMap((section) => section.items);
    expect(items.find((item) => item.path === '/mcp')?.access).toBe('ready');
    expect(items.find((item) => item.path === '/claude-md')?.access).toBe('ready');
    // Не заявленные возможности скрыты (fail-closed).
    const paths = items.map((item) => item.path);
    expect(paths).not.toContain('/hooks');
    expect(paths).not.toContain('/env');
    expect(items.find((item) => item.path === '/scripts')?.access).toBe('ready');
    // ready: инструкции + MCP + проекты + скрипты.
    expect(summarizeNavCapabilities(CURSOR).ready).toBe(4);
  });

  it('opencode: рабочие MCP + Инструкции, остальное — заглушки', () => {
    const items = gateNavSections(NAV_SECTIONS, OPENCODE).flatMap((section) => section.items);
    expect(items.find((item) => item.path === '/mcp')?.access).toBe('ready');
    expect(items.find((item) => item.path === '/claude-md')?.access).toBe('ready');
    expect(items.find((item) => item.path === '/permissions')?.access).toBe('inDevelopment');
    expect(items.find((item) => item.path === '/env')?.access).toBe('inDevelopment');
    expect(items.find((item) => item.path === '/scripts')?.access).toBe('ready');
    // COMMON-2: плюс проектный уровень → MCP + инструкции + проекты + скрипты.
    expect(summarizeNavCapabilities(OPENCODE).ready).toBe(4);
  });

  it('aider: рабочий только раздел скриптов, остальное «в разработке» или скрыто', () => {
    const items = gateNavSections(NAV_SECTIONS, AIDER).flatMap((section) => section.items);
    expect(
      items.filter((item) => item.access === 'ready' && item.capability).map((item) => item.path),
    ).toEqual(['/scripts']);
    expect(summarizeNavCapabilities(AIDER).ready).toBe(1);
  });
});
