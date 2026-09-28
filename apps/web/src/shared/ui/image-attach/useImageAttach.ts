import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AGENT_IMAGE_MAX_COUNT,
  isAgentImageName,
  type AgentImage,
} from '@agentdeck/contracts/agent-images';
import {
  AgentImageError,
  ATTACH_MAX_BYTES,
  carriesFiles,
  filesOf,
  pastedName,
  planAttach,
  prepareAgentImage,
  uniqueName,
} from '@shared/lib/attach';
import { formatBytesIn } from '@shared/lib/format';
import { NO_REFUSALS, refusalText, type ImageRefusals } from './refusal';
import type { AttachedImage, ImageAttachApi, UseImageAttachOptions } from './image-attach.types';

let nextId = 0;

/**
 * Картинки в поле агента: кнопка, перетаскивание и вставка Ctrl+V — одно
 * поведение для всех полей панели. Отказ — в момент вложения и словами (имя,
 * настоящий размер, предел), а не молча и не при отправке.
 */
export function useImageAttach({ disabled = false }: UseImageAttachOptions = {}): ImageAttachApi {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<AttachedImage[]>([]);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Приложенные и летящие считаются мимо рендера. Состояние внутри асинхронного
  // вложения устарело бы, пока идёт ужатие предыдущих, а счёт, переписываемый из
  // `items` на каждом рендере, забывал летящие: две быстрые вставки по пять
  // давали десять чипов при пределе восемь (ревью 28.09 F-93). Список ведётся
  // здесь синхронно и только потом уходит в состояние.
  const listRef = useRef<AttachedImage[]>([]);
  const inFlightRef = useRef(0);
  // Номер последнего начатого вложения. Первая из двух вставок ужимает пять
  // картинок дольше второй и заканчивает позже: её чистый итог стирал отказ
  // второй — «p8, p9 не приложены» исчезал (кейс panel-agent-011). Чистый итог
  // убирает отказ, только если после него ничего не начиналось.
  const lastAddRef = useRef(0);
  const commit = (next: AttachedImage[]): void => {
    listRef.current = next;
    setItems(next);
  };

  // Миниатюры — object URL: без отзыва каждый снимок держал бы память до F5.
  const urlsRef = useRef(new Set<string>());
  // Поле снято, пока картинка ещё ужимается, — URL после уборки уже никто не
  // отзовёт (F-341). Живо ли поле, смотрим перед каждым созданием.
  const aliveRef = useRef(true);
  useEffect(() => {
    const urls = urlsRef.current;
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  const revoke = (url: string): void => {
    URL.revokeObjectURL(url);
    urlsRef.current.delete(url);
  };

  const size = useCallback(
    (bytes: number): string =>
      formatBytesIn(
        bytes,
        {
          bytes: (count) => t('common.bytes', { count }),
          kilobytes: t('common.kilobytes'),
          megabytes: t('common.megabytes'),
        },
        i18n.language,
      ),
    [t, i18n.language],
  );

  const add = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      // Поле занято — отказ словами, а не тишина: вставка уже перехвачена, и
      // без строки человек не узнал бы, куда делась картинка.
      if (disabled) {
        setRefusal(t('attach.busy', { names: files.map((file) => file.name).join(', ') }));
        return;
      }
      lastAddRef.current += 1;
      const seq = lastAddRef.current;
      const plan = planAttach(files, { accepts: isAgentImageName, maxBytes: ATTACH_MAX_BYTES });
      const refusals: ImageRefusals = {
        ...NO_REFUSALS,
        notImage: [...plan.unsupported],
        tooLarge: [...plan.tooLarge],
        tooMany: [],
        failed: [],
      };
      const room = Math.max(
        0,
        AGENT_IMAGE_MAX_COUNT - listRef.current.length - inFlightRef.current,
      );
      const taken = plan.accepted.slice(0, room);
      refusals.tooMany = plan.accepted.slice(room).map((file) => file.name);
      inFlightRef.current += taken.length;

      setPending((value) => value + taken.length);
      const prepared = await Promise.all(
        taken.map(async (file) => {
          try {
            const { image } = await prepareAgentImage(file);
            if (!aliveRef.current) return undefined;
            const previewUrl = URL.createObjectURL(file);
            urlsRef.current.add(previewUrl);
            nextId += 1;
            return {
              id: `img-${nextId}`,
              name: image.name,
              sizeBytes: file.size,
              previewUrl,
              image,
            } satisfies AttachedImage;
          } catch (error) {
            if (error instanceof AgentImageError && error.reason === 'not-image') {
              refusals.notImage.push(file.name);
            } else {
              refusals.failed.push({
                name: file.name,
                reason:
                  error instanceof AgentImageError && error.reason === 'too-large'
                    ? 'too-large'
                    : 'unreadable',
              });
            }
            return undefined;
          }
        }),
      );
      inFlightRef.current -= taken.length;
      if (!aliveRef.current) return;
      setPending((value) => value - taken.length);
      const names = new Set(listRef.current.map((item) => item.name));
      const accepted = prepared
        .filter((item): item is AttachedImage => Boolean(item))
        .map((item) => {
          const name = uniqueName(item.name, names);
          names.add(name);
          return name === item.name ? item : { ...item, name, image: { ...item.image, name } };
        });
      if (accepted.length > 0) commit([...listRef.current, ...accepted]);
      const text = refusalText(refusals, t, size, {
        maxBytes: ATTACH_MAX_BYTES,
        maxCount: AGENT_IMAGE_MAX_COUNT,
      });
      if (text !== undefined || seq === lastAddRef.current) setRefusal(text);
    },
    [disabled, size, t],
  );

  const remove = useCallback((id: string): void => {
    const gone = listRef.current.find((item) => item.id === id);
    if (gone) {
      revoke(gone.previewUrl);
      commit(listRef.current.filter((item) => item.id !== id));
    }
    setRefusal(undefined);
  }, []);

  const clear = useCallback((): void => {
    for (const item of listRef.current) revoke(item.previewUrl);
    commit([]);
    setRefusal(undefined);
  }, []);

  const images = useMemo<AgentImage[]>(() => items.map((item) => item.image), [items]);

  return {
    items,
    images,
    refusal,
    isPreparing: pending > 0,
    isDragging,
    disabled,
    add,
    remove,
    clear,
    inputRef,
    openPicker: () => inputRef.current?.click(),
    onPaste: (event) => {
      const files = filesOf(event.clipboardData);
      // Текст вставляется как обычно — перехватываем только файлы.
      if (files.length === 0) return;
      event.preventDefault();
      const now = new Date();
      void add(
        files.map((file) => {
          const name = pastedName(file, now);
          return name === file.name ? file : new File([file], name, { type: file.type });
        }),
      );
    },
    dropZone: {
      // Файл над полем перехватывается всегда, и над занятым тоже: иначе браузер
      // открывал брошенную картинку вместо страницы, и набранное пропадало
      // (ревью 28.09 F-94). Занятое поле отказывает словами при броске.
      onDragOver: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (!disabled) setIsDragging(true);
      },
      onDragLeave: (event) => {
        // Переход на дочерний элемент — не уход из поля.
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setIsDragging(false);
      },
      onDrop: (event) => {
        setIsDragging(false);
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        const files = filesOf(event.dataTransfer);
        if (files.length > 0) void add(files);
      },
    },
  };
}
