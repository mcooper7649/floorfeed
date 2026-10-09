import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { C } from '@/constants/brand';
import { AuthProvider } from '@/lib/auth';
import { TradeModeProvider } from '@/lib/mode';
import { SessionProvider } from '@/lib/session';
import { WalletProvider } from '@/lib/wallet';

SplashScreen.preventAutoHideAsync();

const web = Platform.OS === 'web';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, primary: C.accent, text: C.text, border: C.border },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <AuthProvider>
      <SessionProvider>
      <WalletProvider>
      <TradeModeProvider>
        <StatusBar style="light" />
        <AnimatedSplashOverlay />
        <Stack screenOptions={{ contentStyle: { backgroundColor: C.bg } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {/* Web draws its own header (TopNav) on these pages */}
          <Stack.Screen name="wallet/[address]" options={{ title: 'Wallet', headerBackTitle: 'Back', headerShown: !web }} />
          <Stack.Screen name="collection/[symbol]" options={{ title: 'Collection', headerBackTitle: 'Back', headerShown: !web }} />
        </Stack>
      </TradeModeProvider>
      </WalletProvider>
      </SessionProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
