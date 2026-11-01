import type { LayerRunDecision, SkillMode } from '@agentdeck/contracts/core/user-layer';
import type { AdapterCaps, LayerRun } from '../adapter.types.ts';
import { LOSS_PREFIX } from '../layer-inventory.ts';

/**
 * Единственный судья класса `layer-run` (`decisions.ts`, 06:114-119, G3, G-b): с каким слоем
 * сеанс пошёл на деле. Хуки — по слою запуска (`LayerRun`: доверие, понижение недоверенной копии,
 * CLI без управления слоем); навыки — по просьбе и `caps.skillControl`: CLI, который навыки не
 * отключает, идёт с навыками, и это названо. Потери частей слоя (`LayerRun.losses`) — в `detail`
 * строками `loss: …`: решение в журнале называет каждую.
 */

export interface LayerRunInput {
  layer: LayerRun;
  /** Навыки, которые просили (`spec.layer.skills`; нет поля — `on`). */
  skills: SkillMode;
  caps: Pick<AdapterCaps, 'skillControl'>;
  /** Хеш описи слоя; `null` — опись не прочитана. */
  inventoryHash: string | null;
  /** Имя переходника — в подписи подмены навыков. */
  cli: string;
}

const items = (detail: string | undefined): string[] =>
  detail ? detail.split('; ').filter((item) => item.length > 0) : [];

export function decideLayerRun(input: LayerRunInput): LayerRunDecision {
  const { layer, skills } = input;
  const ranSkills: SkillMode = skills === 'off' && !input.caps.skillControl ? 'on' : skills;
  const detail = [
    ...items(layer.detail),
    ...(layer.losses ?? []).map((loss) => `${LOSS_PREFIX}${loss}`),
  ];
  if (ranSkills !== skills) detail.push(`${input.cli}: no skill control: skills ${skills} → on`);
  return {
    asked: { hooks: layer.asked, skills },
    ran: { hooks: layer.ran, skills: ranSkills },
    repoLayer: layer.repoLayer,
    trust: layer.trust,
    inventoryHash: input.inventoryHash,
    detail,
  };
}
