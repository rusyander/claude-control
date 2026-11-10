import type { BoardEntry, BoardSource } from '@agentdeck/contracts/core/board';

/**
 * Доказательство старта (этап 12, P183): доска не запускает того, что человек не разрешил.
 * Ход человека (`human`) держит само; запись настройки (`config`) перепроверяется на старте —
 * запись с этим `cmdId` должна быть в истории настройки ядра, сделана человеком и включать
 * автоочередь ИМЕННО источника записи, И автоочередь источника должна быть включена сейчас.
 * Выключили — запись возвращается во «Входящие» с причиной, а не стартует по старому слову.
 */

/** Запись истории настройки, как её видит суд: кто доказан и что запись расширила. */
export interface ProofConfigCmd {
  by: string;
  warnings: readonly { section: string; detail: string }[];
}

export interface ProofDeps {
  /** Есть ли в истории настройки ядра запись с этим `cmdId`; нечитаемая история — бросает. */
  configCmdExists(cmdId: string): boolean;
  /**
   * Запись истории настройки с этим `cmdId` (этап 12, Z7); нечитаемая история — бросает. Дана —
   * суд требует человека и предупреждение `autoQueue on <источник>`, а не просто наличие записи.
   */
  configCmd?(cmdId: string): ProofConfigCmd | undefined;
  /** Включена ли автоочередь для источника записи сейчас (раздел `inbox`, волна 2). */
  autoQueueOf(source: BoardSource): boolean;
}

export type ProofVerdict = { ok: true } | { ok: false; reason: string };

/** Записи настройки, доказывающие человека (08e). */
const HUMAN_BY: ReadonlySet<string> = new Set(['nonce+peer', 'device-signature']);

function enabledBy(cmd: ProofConfigCmd, source: BoardSource): boolean {
  const detail = `autoQueue on ${source.system ?? ''}`;
  return cmd.warnings.some((w) => w.section === 'inbox' && w.detail === detail);
}

export function checkStartProof(entry: BoardEntry, deps: ProofDeps): ProofVerdict {
  const proof = entry.proof;
  if (!proof)
    return {
      ok: false,
      reason: 'no start proof: queue it by hand or enable auto-queue for its source',
    };
  if (proof.kind === 'human') return { ok: true };
  if (deps.configCmd) {
    let cmd: ProofConfigCmd | undefined;
    try {
      cmd = deps.configCmd(proof.cmdId);
    } catch (error) {
      return { ok: false, reason: `config history unreadable: ${(error as Error).message}` };
    }
    if (!cmd)
      return { ok: false, reason: `config write ${proof.cmdId} is not in the config history` };
    if (!deps.autoQueueOf(entry.source)) return autoQueueOff(entry);
    if (!HUMAN_BY.has(cmd.by))
      return { ok: false, reason: `config write ${proof.cmdId} was not made by a human` };
    if (!enabledBy(cmd, entry.source))
      return {
        ok: false,
        reason: `config write ${proof.cmdId} did not enable auto-queue for source ${entry.source.system ?? entry.source.kind}`,
      };
  } else {
    let exists: boolean;
    try {
      exists = deps.configCmdExists(proof.cmdId);
    } catch (error) {
      return { ok: false, reason: `config history unreadable: ${(error as Error).message}` };
    }
    if (!exists)
      return { ok: false, reason: `config write ${proof.cmdId} is not in the config history` };
  }
  if (!deps.autoQueueOf(entry.source)) return autoQueueOff(entry);
  return { ok: true };
}

function autoQueueOff(entry: BoardEntry): ProofVerdict {
  const named = entry.source.system ? ` (source ${entry.source.system})` : '';
  return { ok: false, reason: `auto-queue is off for ${entry.source.kind} sources now${named}` };
}
