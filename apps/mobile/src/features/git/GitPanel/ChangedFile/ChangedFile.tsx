import type { ProjectGitChange } from '@agentdeck/contracts';
import { Row, Mono, Muted } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';
import { Text } from 'react-native';
import { styles } from '../GitPanel.styles';
import { MARKS } from './ChangedFile.constants';

export function ChangedFile({ change, staged }: { change: ProjectGitChange; staged: string }) {
  return (
    <Row gap={space.sm}>
      <Text style={[styles.mark, change.status === 'conflict' && styles.failed]}>
        {MARKS[change.status]}
      </Text>
      <Mono style={styles.grow} numberOfLines={1}>
        {change.path}
      </Mono>
      {change.staged ? <Muted>{staged}</Muted> : null}
    </Row>
  );
}
