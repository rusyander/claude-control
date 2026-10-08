import { Figure } from '../Figure/Figure';
import styles from './PlatformKeyDiagram.module.scss';
import { Box } from '../Box/Box';
import type { DiagramProps } from '../PlatformDiagrams.types';

/** Диаграмма «что происходит с ключом»: где живёт ключ и куда он не попадает. */
export function PlatformKeyDiagram({ tr }: DiagramProps) {
  return (
    <Figure title={tr('d3Title')} viewBox="0 0 700 270">
      <rect x={8} y={20} width={302} height={190} rx={10} className={styles.zone} />
      <text x={159} y={44} className={styles.zoneLabel} textAnchor="middle">
        {tr('d3Panel')}
      </text>
      <Box x={30} y={62} w={258} h={52} lines={[tr('d3Vault')]} />
      <Box x={30} y={134} w={258} h={52} lines={[tr('d3Key')]} tone="accent" />

      <rect x={390} y={20} width={302} height={190} rx={10} className={styles.zone} />
      <text x={541} y={44} className={styles.zoneLabel} textAnchor="middle">
        {tr('d3Files')}
      </text>
      <Box x={412} y={62} w={258} h={52} lines={[tr('d3Address')]} />
      <Box x={412} y={134} w={258} h={52} lines={[tr('d3Stub')]} />

      <line x1={312} y1={115} x2={388} y2={115} className={styles.arrow} />
      <line x1={338} y1={99} x2={362} y2={131} className={styles.cross} />
      <line x1={362} y1={99} x2={338} y2={131} className={styles.cross} />
      <text x={350} y={246} className={styles.note} textAnchor="middle">
        {tr('d3Never')}
      </text>
    </Figure>
  );
}
