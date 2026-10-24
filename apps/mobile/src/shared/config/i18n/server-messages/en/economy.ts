import type { EconomyMessageCode } from '@agentdeck/contracts/server-messages';

export const economyEn: Record<EconomyMessageCode, string> = {
  'economy-note-no-key': 'This CLI has no setting for it.',
  'economy-note-hardcoded-limit': 'The limit is built into the CLI and cannot be changed.',
  'economy-note-config-only':
    "Only the CLI's own settings file sets it; a per-run override would move all of its settings.",
  'economy-note-no-ide':
    'The panel runs this CLI without an editor attached, so there is nothing to detach.',
  'economy-note-cache-implicit':
    'This provider caches implicitly; the cache lifetime cannot be set.',
  'economy-note-anthropic-only': 'Works only when signed in through Anthropic.',
  'economy-note-one-shot':
    'Each answer is a separate run with a short history, so nothing is kept between turns.',
  'economy-note-live-session':
    "The setting would move the conversation out of the CLI's live session into one-shot runs, which costs more than it saves.",
  'economy-note-no-model-ladder': 'The CLI has no cheaper model to move delivery onto.',
  'economy-note-keep-warm-cost':
    'A cache ping costs more than it saves here: the provider charges no write premium and the cache lifetime cannot be controlled.',
  'economy-note-local-model': 'Local model: tokens and cache cost nothing.',
  'economy-note-no-tool-loop':
    'The CLI does not call tools on its own, so the lever has nothing to change.',
  'economy-note-disproportionate':
    'The CLI has a setting, but enabling it for one run costs more than it would save.',
  'economy-note-shared-tool-limit':
    'The CLI has one limit for every tool, file reads included; the shell-output lever sets it.',
  'economy-note-keep-warm-short-ttl':
    "The provider's cache lives for minutes: pinging that often would cost more than it saves; on a local model the cache costs nothing.",
  'economy-note-admin-settings':
    "Only the CLI's settings carry this key. The CLI accepts a per-run settings file only if an administrator owns it, and a per-run CLI home would move all of its settings and sign-in.",
  'economy-note-provider-unknown':
    'The model comes from a provider chosen inside the CLI: the panel knows neither its cache price nor its lifetime, so it cannot tell when the cache went cold or whether a ping pays off.',
  'economy-note-no-effect':
    'The CLI has a setting, but a probe showed it does not change the request to the model.',
  'economy-note-not-runnable':
    'The panel does not run this CLI in chat, so the levers have nothing to change.',
  'economy-note-shared-tool-limit-larger':
    'The CLI has one limit for all tools: the larger of the two levers applies — shell output or file reads — so a file is not cut short.',
  'economy-note-window-known-only':
    "Works when the model's window is known: set in the CLI itself, a local model's limits, the contour model's window, or a cloud model's window from the panel's model catalog. Otherwise the CLI compacts history at its own threshold.",
  'economy-note-cloud-only':
    'Works only with a cloud model: a local model has no provider cache to go cold, so the conversation always continues.',
};
