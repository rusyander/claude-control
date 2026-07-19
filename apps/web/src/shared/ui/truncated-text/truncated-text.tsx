import { useEffect, useRef, useState } from 'react';
import { Typography } from '@shared/ui/typography';
import type { TruncatedTextProps } from './truncated-text.types';

/**
 * Текст в одну строку с подсказкой при наведении — но подсказка появляется
 * только если текст действительно не поместился. Вешать title на всё подряд
 * нельзя: у короткого текста всплывающее дублирование только мешает.
 *
 * Ширина перепроверяется при изменении размеров контейнера, иначе после
 * сворачивания боковой панели подсказка исчезнет или появится не вовремя.
 */
export function TruncatedText({ text, variant, color, weight, className }: TruncatedTextProps) {
  const ref = useRef<HTMLElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const check = (): void => {
      setIsOverflowing(element.scrollWidth > element.clientWidth + 1);
    };

    check();

    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <Typography
      ref={ref}
      variant={variant}
      color={color}
      weight={weight}
      className={className}
      as="span"
      truncate
      title={isOverflowing ? text : undefined}
    >
      {text}
    </Typography>
  );
}
