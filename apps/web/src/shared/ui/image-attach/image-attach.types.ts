import type { ClipboardEvent, DragEvent, HTMLAttributes, ReactNode, RefObject } from 'react';
import type { AgentImage } from '@agentdeck/contracts/agent-images';

/** Картинка в поле до отправки. */
export interface AttachedImage {
  id: string;
  /** Имя, под которым картинка уйдёт (после ужатия PNG мог стать JPG). */
  name: string;
  /** Размер исходного файла — показывается в подсказке чипа. */
  sizeBytes: number;
  /** Адрес миниатюры (object URL исходного файла). */
  previewUrl: string;
  image: AgentImage;
}

/** Состояние и обработчики вложения картинок одного поля. */
export interface ImageAttachApi {
  items: AttachedImage[];
  /** Картинки для тела запроса, по порядку вложения. */
  images: AgentImage[];
  /** Отказ последнего вложения словами — с именем и настоящим размером. */
  refusal: string | undefined;
  isPreparing: boolean;
  isDragging: boolean;
  disabled: boolean;
  add: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  /** Снять все чипы — после принятой отправки. */
  clear: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  openPicker: () => void;
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  dropZone: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

export interface UseImageAttachOptions {
  /** Поле заперто (идёт ход): вложения не принимаются ни одним путём. */
  disabled?: boolean;
}

export interface ImageAttachButtonProps {
  attach: ImageAttachApi;
  size?: 'sm' | 'md';
  className?: string;
}

export interface ImageAttachTrayProps {
  attach: ImageAttachApi;
  className?: string;
}

export interface ImageAttachZoneProps extends HTMLAttributes<HTMLDivElement> {
  attach: ImageAttachApi;
  children: ReactNode;
}

export interface SentImageNamesProps {
  names: readonly string[];
  /** На тёмном пузыре реплики человека — светлый текст. */
  inverse?: boolean;
}
