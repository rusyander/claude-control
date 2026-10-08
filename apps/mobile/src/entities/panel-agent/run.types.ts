import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';

/** Получатель кадров хода: событие и его номер, если сервер его дал. */
export type RunEventSink = (event: PanelAgentRunEvent, seq?: number) => void;

export type PanelAgentRunOutcome =
  | { ok: true }
  | {
      ok: false;
      code?: string;
      status?: number;
      message: string;
      aborted?: boolean;
      /** Сервер прислал код текста (`messageCode`): `message` уже на языке телефона. */
      localized?: boolean;
    };
