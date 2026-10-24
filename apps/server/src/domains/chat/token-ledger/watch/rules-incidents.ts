import { awaitsAnswer } from '../../group-questions/group-wait.ts';
import {
  clip,
  EVENT_HOLD_MS,
  MINUTE_MS,
  minutes,
  openAsk,
  recent,
  type Rule,
  within,
} from './rules-util.ts';

/**
 * Правила пробелов покрытия 23.10 (R24–R27, R29–R33): поводы копит свёртка
 * (`reduce-incidents.ts`), здесь — только условие, числа и подстановки строки.
 * R22, R23 и R28 — правила группы и плана: их считает сторож по своим спискам.
 */

/** Слова вердикта ревью в тексте: блок ревью конвейер читает, прозу — нет (R33). */
const VERDICT_WORDS = /\b(?:APPROVE[D]?|REQUEST[_ ]CHANGES|LGTM)\b|вердикт|одобр|замечани/iu;

export const INCIDENT_RULES = {
  R24(state, _node, ctx, now) {
    const span = ctx.settings.errorMinutes * MINUTE_MS;
    let worst:
      { fails: number; first: number; label: string; head: string; print?: string } | undefined;
    for (const run of Object.values(state.errors)) {
      const ats = run.ats.filter((at) => at <= now && now - at <= span);
      const first = ats[0];
      if (first === undefined || ats.length < ctx.settings.errorRepeats) continue;
      if (!worst || ats.length > worst.fails) {
        worst = { fails: ats.length, first, label: run.label, head: run.head, print: run.print };
      }
    }
    if (!worst) return undefined;
    return {
      numbers: { fails: worst.fails },
      params: {
        call: clip(worst.label),
        error: clip(worst.head, 120),
        ...(worst.print ? { sig: worst.print } : {}),
      },
      since: worst.first,
    };
  },

  R25(state, _node, _ctx, now) {
    const last = recent(state.bypasses, now).at(-1);
    if (!last) return undefined;
    return {
      numbers: { afterMin: minutes(last.afterMs) },
      params: { op: last.op, command: clip(last.command) },
      since: last.at,
    };
  },

  R26(state, _node, _ctx, now) {
    const kills = recent(state.kills, now);
    const last = kills.at(-1);
    if (!last) return undefined;
    return {
      numbers: { kills: kills.length },
      params: { target: clip(last.target, 80) },
      since: last.at,
    };
  },

  R27(state, node, ctx, now) {
    // Вопрос текстом читает человек — сигнал, только когда подхватить его некому (ставит проводка).
    if (!node.proseWait || state.endedAt === undefined || !state.endText) return undefined;
    if (openAsk(state, node) || !awaitsAnswer(state.endText)) return undefined;
    const waited = now - state.endedAt;
    if (waited < ctx.settings.proseWaitMinutes * MINUTE_MS) return undefined;
    const alert = waited >= ctx.settings.askAlertMinutes * MINUTE_MS;
    const question = state.endText.trim();
    return {
      ...(alert ? { severity: 'alert' as const } : {}),
      numbers: { waitMin: minutes(waited) },
      params: { question: question.length > 200 ? `…${question.slice(-199)}` : question },
      since: state.endedAt,
    };
  },

  R29(state, node, ctx, now, scope) {
    const calls = recent(state.missingTools, now);
    const last = calls.at(-1);
    if (!last) return undefined;
    // MR на доставке (или в одиночном чате) без инструмента форжа — сразу: дальше доставки нет.
    const forgeNow = calls.some(
      (call) => call.forge && (scope === 'chat' || (call.stage ?? node.stage) === 'deliver'),
    );
    if (!forgeNow && calls.length < ctx.settings.missingToolRepeats) return undefined;
    return {
      numbers: { calls: calls.length },
      params: { tool: clip(last.tool, 80) },
      since: calls[0]?.at ?? last.at,
    };
  },

  R30(state, _node, ctx, now) {
    const outages = within(state.outages, now, ctx.settings.outageMinutes * MINUTE_MS);
    const first = outages[0];
    const last = outages.at(-1);
    if (!first || !last || outages.length < ctx.settings.outageRepeats) return undefined;
    const byService = new Map<string, number>();
    for (const outage of outages) {
      byService.set(outage.service, (byService.get(outage.service) ?? 0) + 1);
    }
    const service = [...byService].sort((a, b) => b[1] - a[1])[0]?.[0] ?? last.service;
    return {
      numbers: { failures: outages.length, spanMin: Math.max(1, minutes(last.at - first.at)) },
      params: { service: clip(service, 80) },
      since: first.at,
    };
  },

  R31(state, _node, _ctx, now) {
    const writes = recent(state.outsideWrites, now);
    const last = writes.at(-1);
    if (!last) return undefined;
    return {
      numbers: { writes: writes.length },
      params: { path: clip(last.path, 120) },
      since: writes[0]?.at ?? last.at,
    };
  },

  R32(state, _node, ctx, now) {
    const buckets = within(state.inserts, now, ctx.settings.insertMinutes * MINUTE_MS);
    const chars = buckets.reduce((sum, bucket) => sum + bucket.chars, 0);
    const first = buckets[0];
    const last = buckets.at(-1);
    if (!first || !last || chars < ctx.settings.insertChars) return undefined;
    const byType: Record<string, number> = {};
    for (const bucket of buckets) {
      for (const [type, size] of Object.entries(bucket.byType)) {
        byType[type] = (byType[type] ?? 0) + size;
      }
    }
    const type = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    return {
      numbers: {
        insertK: Math.round(chars / 1000),
        spanMin: Math.max(1, minutes(last.at - first.at)),
      },
      params: { type },
      since: first.at,
    };
  },

  R33(state, node, _ctx, now) {
    if (node.stage !== 'review' || state.reviewFenceSeen) return undefined;
    const endedAt = state.endedAt;
    if (endedAt === undefined || now - endedAt > EVENT_HOLD_MS || !state.endText) return undefined;
    if (!VERDICT_WORDS.test(state.endText)) return undefined;
    return { numbers: {}, since: endedAt };
  },
} satisfies Record<string, Rule>;
