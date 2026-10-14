import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PlatformRunPlan } from '@agentdeck/contracts';
import {
  LOCAL_LEAN_BASE_TOKENS,
  LOCAL_MCP_MIN_HEADROOM_TOKENS,
  type LocalMcpInfo,
  type LocalMcpServer,
} from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { ChatModelPicker } from '../ChatModelPicker';
import { LocalMcpPanel } from './LocalMcpPanel';
import { LocalMcpPicker } from './LocalMcpPicker';

/**
 * MCP-серверы локального прогона в шапке чата (L4): кнопка и подпись слоёв из плана
 * прогона, раскрытый список из ответа сервера. Данные — в кеше запросов тем же ключом,
 * которым их спрашивает настоящий хук; сами компоненты не подменяются.
 */

const PROJECT = '/work/app';
const server = (over: Partial<LocalMcpServer> & { id: string }): LocalMcpServer => ({
  scope: 'user',
  transport: 'http',
  tokens: null,
  tools: null,
  picked: false,
  ...over,
});

const compactAt = 44_344;
const info = (servers: LocalMcpServer[], picked: string[]): LocalMcpInfo => {
  const used = servers
    .filter((item) => picked.includes(item.id))
    .reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  return {
    project: PROJECT,
    context: 65_536,
    compactAt,
    baseTokens: LOCAL_LEAN_BASE_TOKENS,
    headroom: compactAt - LOCAL_LEAN_BASE_TOKENS - used,
    servers: servers.map((item) => ({ ...item, picked: picked.includes(item.id) })),
    picked,
  };
};

const lean: PlatformRunPlan = {
  routed: true,
  platformId: 'local-ollama',
  title: 'Локальная модель',
  rules: { model: 'qwen', source: 'default', map: {}, catalog: [] },
  effort: true,
  layers: {
    args: ['--strict-mcp-config'],
    systemPrompt: true,
    dropped: ['mcp'],
  },
};

function renderHeader(plan: PlatformRunPlan, projectPath?: string): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.platformRunPlan('chat', projectPath ?? ''), plan);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatModelPicker
        model=""
        effort=""
        defaultModel="opus"
        defaultEffort=""
        {...(projectPath ? { projectPath } : {})}
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

const panel = (data: LocalMcpInfo | undefined, extra: { measuring?: boolean } = {}): string =>
  renderToStaticMarkup(
    <LocalMcpPanel
      data={data}
      loadFailed={false}
      saving={false}
      measuring={extra.measuring ?? false}
      onToggle={() => undefined}
      onRemeasure={() => undefined}
    />,
  );

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('шапка чата: MCP локального прогона', () => {
  it('облегчённый локальный прогон с проектом — есть кнопка «MCP: 0» и подпись слоя', () => {
    const html = renderHeader({ ...lean, localMcp: { picked: [] } }, PROJECT);
    expect(html).toContain(i18n.t('chat.localMcp.button', { count: 0 }));
    // Подпись слоёв называет снятое; взятых серверов нет — строки «MCP по выбору» тоже.
    expect(html).toContain('MCP-серверы');
    expect(html).not.toContain('MCP по выбору');
  });

  it('взятые серверы названы в подписи слоёв и в числе на кнопке', () => {
    const html = renderHeader({ ...lean, localMcp: { picked: ['gitlab', 'figma'] } }, PROJECT);
    expect(html).toContain(i18n.t('chat.localMcp.button', { count: 2 }));
    expect(html).toContain(i18n.t('chat.localMcp.pickedCaption', { list: 'gitlab, figma' }));
  });

  it('кнопки нет: проекта нет (песочница), облако без контура, прогон не облегчён', () => {
    const noProject = renderHeader({ ...lean, localMcp: { picked: [] } });
    expect(noProject).not.toContain('MCP: ');
    const cloud = renderHeader(
      {
        routed: false,
        title: '',
        reason: 'no_active_platform',
        rules: { model: '', source: 'none', map: {}, catalog: [] },
        effort: true,
      },
      PROJECT,
    );
    expect(cloud).not.toContain('MCP: ');
    // Нет поля localMcp — сервер не считает выбор действующим (набор не облегчён).
    expect(
      renderHeader({ ...lean, layers: { args: [], systemPrompt: true, dropped: [] } }, PROJECT),
    ).not.toContain('MCP: ');
  });

  it('кнопка сама по себе закрыта и не грузит список', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LocalMcpPicker project={PROJECT} picked={['gitlab']} />
      </QueryClientProvider>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('type="checkbox"');
  });
});

describe('раскрытый список MCP-серверов', () => {
  const servers = [
    server({ id: 'gitlab', tokens: 15_040, tools: 39, source: 'server' }),
    server({ id: 'figma', tokens: 3_140, tools: 8, source: 'estimate' }),
    server({ id: 'raw' }),
    server({ id: 'broken', error: 'connect ECONNREFUSED' }),
  ];

  it('цена каждого: счёт сервера, прикидка с «~», не замерен, не отвечает', () => {
    const html = panel(info(servers, []));
    expect(html).toContain(i18n.t('chat.localMcp.cost', { tokens: '15.0k', tools: 39 }));
    expect(html).toContain(i18n.t('chat.localMcp.costEstimate', { tokens: '3.1k', tools: 8 }));
    expect(html).toContain(i18n.t('chat.localMcp.unmeasured'));
    expect(html).toContain(i18n.t('chat.localMcp.failed'));
    expect(html).toContain('connect ECONNREFUSED');
  });

  it('идёт замер — у сервера без цены «считаем…», а не «не замерен»', () => {
    const html = panel(info([server({ id: 'raw' })], []), { measuring: true });
    expect(html).toContain(i18n.t('chat.localMcp.measuring'));
    expect(html).not.toContain(i18n.t('chat.localMcp.unmeasured'));
  });

  it('запас окна называется с цифрой: окно и остаток до сжатия', () => {
    const html = panel(info(servers, ['figma']));
    const headroom = compactAt - LOCAL_LEAN_BASE_TOKENS - 3_140;
    expect(html).toContain(
      i18n.t('chat.localMcp.headroom', {
        headroom: `${(headroom / 1000).toFixed(1)}k`,
        context: '65.5k',
      }),
    );
  });

  it('не влезающий сервер заперт с объяснением, взятый — снимается всегда', () => {
    const big = [
      server({
        id: 'huge',
        tokens: compactAt - LOCAL_LEAN_BASE_TOKENS - LOCAL_MCP_MIN_HEADROOM_TOKENS + 1,
      }),
    ];
    const html = panel(info(big, []));
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain(i18n.t('chat.localMcp.noRoom'));
    // Уже взятый — флажок живой, даже когда остаток ушёл ниже минимума.
    const taken = panel(info(big, ['huge']));
    expect(taken).not.toMatch(/<input[^>]*disabled/);
    expect(taken).toMatch(/<input[^>]*checked/);
  });

  it('взяли больше, чем есть: «не хватает», а не отрицательное число', () => {
    const html = panel(
      info([server({ id: 'a', tokens: 20_000 }), server({ id: 'b', tokens: 20_000 })], ['a', 'b']),
    );
    expect(html).toContain('не хватает');
    expect(html).not.toContain('-8');
    expect(html).toContain('8.3k');
  });

  it('серверов нет — подсказка, откуда они берутся', () => {
    expect(panel(info([], []))).toContain(i18n.t('chat.localMcp.empty'));
  });
});
