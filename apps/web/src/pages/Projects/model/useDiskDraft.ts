import { useEffect, useRef, useState } from 'react';
import { sameText } from '@shared/lib/same-text';
import {
  editDraft,
  isChangedElsewhere,
  savedDraft,
  settleDraft,
  type DiskDraft,
} from './diskDraft';

/**
 * Черновик файла инструкций поверх текста с диска — общий для Claude и прочих
 * CLI (правила в `diskDraft.ts`).
 *
 * `owner` — чей это черновик (проект): у другого он не показывается, и у
 * каждого свой — правка в проекте Б не выбрасывает несохранённое в проекте А
 * (раньше черновик был один на всех, F-299). `version` растёт на каждой замене
 * текста не руками — загрузка с диска, отмена правок, — и редактор по нему
 * берёт текст заново.
 */
export function useDiskDraft(owner: string, disk: string | undefined) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, DiskDraft>>>({});
  const [version, setVersion] = useState(0);
  const draft = drafts[owner];
  // Правка и ответ сохранения приходят из замыканий прошлых рендеров — диск и
  // черновик читаются через ref, а не из них.
  const diskRef = useRef(disk);
  diskRef.current = disk;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const put = (next: DiskDraft | undefined): void =>
    setDrafts((current) => {
      if (next !== undefined) return { ...current, [owner]: next };
      if (!(owner in current)) return current;
      const { [owner]: _dropped, ...rest } = current;
      return rest;
    });

  // Диск сменился: своё сохранение вернулось, файл правили мимо панели, пришёл
  // другой проект. Реагируем только на смену текста.
  useEffect(() => {
    const settled = settleDraft(draftRef.current, disk);
    if (settled.draft !== draftRef.current) put(settled.draft);
    if (settled.reload) setVersion((current) => current + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disk]);

  const value = draft?.value ?? disk;
  return {
    value,
    isDirty: disk !== undefined && value !== undefined && !sameText(value, disk),
    changedElsewhere: isChangedElsewhere(draft, disk),
    version,
    setValue: (next: string): void => put(editDraft(draftRef.current, next, diskRef.current)),
    revert: (): void => {
      put(undefined);
      setVersion((current) => current + 1);
    },
    /** Запись с этим текстом прошла — черновик дальше считается от него. */
    saved: (sent: string): void => put(savedDraft(draftRef.current, sent)),
  };
}
