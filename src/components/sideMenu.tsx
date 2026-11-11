import { router } from 'expo-router';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './ui';

const items = [
  { href: '/config' as const, label: 'Config' },
  { href: '/debug' as const, label: 'Debug' },
];

export function SideMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();

  const openItem = (href: (typeof items)[number]['href']) => {
    onClose();
    router.push(href);
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent visible={open}>
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close menu" onPress={onClose} style={styles.backdrop} />
        <View style={[styles.drawer, { paddingBottom: Math.max(insets.bottom, 16), paddingTop: insets.top + 16 }]}>
          {items.map((item) => (
            <Pressable
              accessibilityRole="button"
              key={item.href}
              onPress={() => openItem(item.href)}
              style={styles.row}
            >
              <Text style={styles.rowLabel}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  drawer: {
    backgroundColor: colors.card,
    borderRightColor: colors.line,
    borderRightWidth: 1,
    bottom: 0,
    elevation: 8,
    left: 0,
    maxWidth: 300,
    zIndex: 2,
    paddingHorizontal: 8,
    position: 'absolute',
    top: 0,
    width: '78%',
  },
  row: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  rowLabel: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
});
