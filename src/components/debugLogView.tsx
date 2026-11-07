import { useSyncExternalStore } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getDebugLines, subscribeDebugLog } from '../ble/debugLog';
import { colors } from './ui';

const LINE_HEIGHT = 20;
const MAX_HEIGHT = 280;

export function DebugLog({ empty }: { empty: string }) {
  const debugLines = useSyncExternalStore(subscribeDebugLog, getDebugLines);
  if (debugLines.length === 0) {
    return <Text style={styles.meta}>{empty}</Text>;
  }

  return (
    <View style={styles.block}>
      <Text style={styles.meta}>Newest first. Kept on this phone.</Text>
      <ScrollView
        nestedScrollEnabled
        style={[styles.scroll, { height: Math.min(MAX_HEIGHT, debugLines.length * LINE_HEIGHT) }]}
      >
        {debugLines.map((line, index) => (
          <Text key={`${index}-${line}`} selectable style={styles.debug}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
  },
  scroll: {
    flexGrow: 0,
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  debug: {
    color: colors.muted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
});
