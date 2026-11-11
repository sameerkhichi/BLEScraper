import '../sync/backgroundSync';
import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppProvider } from '../state/AppProvider';
import { colors } from '../components/ui';

function HomeSettingsButton() {
  return (
    <Pressable
      accessibilityLabel="Settings"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => router.push('/controls')}
      style={styles.headerButton}
    >
      <GearIcon />
    </Pressable>
  );
}

function GearIcon() {
  return (
    <View style={styles.gear}>
      {[0, 45, 90, 135].map((angle) => (
        <View key={angle} style={[styles.gearTooth, { transform: [{ rotate: `${angle}deg` }] }]} />
      ))}
      <View style={styles.gearCap} />
      <View style={styles.gearHub} />
    </View>
  );
}

export default function RootLayout() {
  return (
    <AppProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'BLEScraper', headerRight: () => <HomeSettingsButton /> }} />
        <Stack.Screen name="scan" options={{ title: 'Choose ring' }} />
        <Stack.Screen name="motion" options={{ title: 'Accelerometer' }} />
        <Stack.Screen name="sleep" options={{ title: 'Sleep' }} />
        <Stack.Screen name="stress" options={{ title: 'Stress history' }} />
        <Stack.Screen name="stress-day" options={{ title: 'Stress' }} />
        <Stack.Screen name="config" options={{ title: 'Config' }} />
        <Stack.Screen name="debug" options={{ title: 'Debug' }} />
        <Stack.Screen name="controls" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings" options={{ title: 'API settings' }} />
        <Stack.Screen name="queue" options={{ title: 'Waiting to send' }} />
      </Stack>
    </AppProvider>
  );
}

const styles = StyleSheet.create({
  headerButton: {
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  gear: {
    height: 22,
    width: 22,
  },
  gearTooth: {
    backgroundColor: colors.text,
    borderRadius: 1,
    height: 22,
    left: 8,
    position: 'absolute',
    top: 0,
    width: 6,
  },
  gearCap: {
    backgroundColor: colors.bg,
    borderRadius: 7,
    height: 14,
    left: 4,
    position: 'absolute',
    top: 4,
    width: 14,
  },
  gearHub: {
    backgroundColor: colors.bg,
    borderColor: colors.text,
    borderRadius: 5,
    borderWidth: 2,
    height: 10,
    left: 6,
    position: 'absolute',
    top: 6,
    width: 10,
  },
});
