import type { Platform } from '@agentdeck/contracts';
import { platformIdFromTitle } from '@entities/Platform';
import {
  PLATFORM_PRESETS,
  shimByClientTools,
  platformManifestDeclared,
} from '@agentdeck/contracts';

/**
 * Черновик после правки поля. Идентификатор идёт из имени, пока человек не
 * тронул его сам: он же кусок адреса шлюза, и придумывать его никто не обязан.
 * Тронутый однажды идентификатор имя за собой больше не тянет — иначе правка
 * названия молча уводила бы ключ, который лежит под старым.
 *
 * Драйвер нового контура приносит свои умолчания прослойки и промпта: в мастере
 * этих галочек нет, и тронуть их человек ещё не мог. У сохранённого контура они
 * уже выбор человека (карточка правил), и смена драйвера их не переписывает.
 *
 * Переопределения пресета у нового контура при смене пресета сбрасываются: они
 * сказаны о ПРЕЖНЕМ шлюзе («у моего vLLM ручки Anthropic нет»), и молча
 * перенесённые на другой стали бы утверждением, которого никто не делал.
 *
 * Объявление инструментов у НОВОГО контура тянет за собой умолчание прослойки:
 * человек, сказавший «поле мой шлюз принимает, а модель по нему не зовёт»
 * (`native-no-call`), сказал этим и то, что руки агенту даёт только прослойка.
 * У сохранённого контура галочка — уже его выбор, и переопределение её не трогает.
 */
export function draftWithPatch(
  current: Platform,
  fields: Partial<Platform>,
  idTouched: boolean,
  isNew = false,
): Platform {
  const next = { ...current, ...fields };
  if (fields.title !== undefined && !idTouched) next.id = platformIdFromTitle(fields.title);
  if (isNew && fields.driver !== undefined && fields.driver !== current.driver) {
    Object.assign(next, PLATFORM_PRESETS[fields.driver].defaults);
    delete next.manifest;
    return next;
  }
  if (isNew && fields.manifest !== undefined) {
    next.toolShim = shimByClientTools(
      platformManifestDeclared(next.driver, next.manifest).clientTools,
    );
  }
  return next;
}
