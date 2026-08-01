import { useArtifactSource } from '@entities/Chat';
import type { ArtifactPlainTextProps } from './ArtifactPreview.types';
import styles from './ArtifactPreview.module.scss';

export function ArtifactPlainText({ chatId, name }: ArtifactPlainTextProps) {
  const source = useArtifactSource(chatId, name);
  return <div className={styles.source}>{source.data}</div>;
}
