import { describe, expect, it } from 'vitest';
import type { LayerMode, SessionSpec } from '../adapter.types.ts';
import { resolveLayer, type CliTrustRead, type LayerPolicy } from './layer-run.ts';

/** F-86: доверие — отметка исходного репозитория; без неё слой репозитория не доходит. */

function spec(hooks: LayerMode, trust?: SessionSpec['trust']): SessionSpec {
  return {
    layer: { hooks },
    env: { pin: { HOME: '/h' } },
    ...(trust ? { trust } : {}),
  } as unknown as SessionSpec;
}

function policy(read: CliTrustRead): LayerPolicy & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    readCliMark: async (source) => {
      asked.push(source);
      return read;
    },
    untrusted: (mode) => (mode === 'on' ? 'observe' : mode),
  };
}

describe('resolveLayer — F-86 the trust of the source repo decides the repo layer', () => {
  it('F-86: no source repo → untrusted, on runs as observe, the CLI record is not read', async () => {
    const p = policy({ trusted: true });
    expect(await resolveLayer(spec('on'), p)).toEqual({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
      detail: 'the launch names no source repo',
    });
    expect(p.asked).toEqual([]);
  });

  it('F-86: the panel mark trusts without reading the CLI record', async () => {
    const p = policy({ unknown: 'must not be read' });
    expect(await resolveLayer(spec('on', { sourceRepo: '/src', panelMark: true }), p)).toEqual({
      asked: 'on',
      ran: 'on',
      repoLayer: true,
      trust: 'panel',
    });
    expect(p.asked).toEqual([]);
  });

  it('F-86: the CLI record of the SOURCE path trusts; no mark or an unknown read does not', async () => {
    const trusted = policy({ trusted: true });
    const run = await resolveLayer(spec('on', { sourceRepo: '/src', panelMark: false }), trusted);
    expect(run).toEqual({ asked: 'on', ran: 'on', repoLayer: true, trust: 'cli' });
    expect(trusted.asked).toEqual(['/src']);

    const none = await resolveLayer(
      spec('on', { sourceRepo: '/src', panelMark: false }),
      policy({ trusted: false, detail: 'no rule' }),
    );
    expect(none).toEqual({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
      detail: 'no rule',
    });

    const unknown = await resolveLayer(
      spec('on', { sourceRepo: '/src', panelMark: false }),
      policy({ unknown: 'garbage' }),
    );
    expect(unknown).toEqual({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'unknown',
      detail: 'garbage',
    });
  });

  it('F-86: observe and off keep their mode; untrusted they still drop the repo layer', async () => {
    for (const mode of ['observe', 'off'] as const) {
      expect(await resolveLayer(spec(mode), policy({ trusted: true }))).toMatchObject({
        asked: mode,
        ran: mode,
        repoLayer: false,
      });
      expect(
        await resolveLayer(
          spec(mode, { sourceRepo: '/s', panelMark: true }),
          policy({ trusted: false }),
        ),
      ).toMatchObject({ asked: mode, ran: mode, repoLayer: true });
    }
  });
});
