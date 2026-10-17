import { DarkTheme, Stack, ThemeProvider, usePathname } from 'expo-router';
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { AccountSetup } from '@/components/account-setup';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { DiscoveryPanel } from '@/components/discovery-panel';
import { PortfolioPanel } from '@/components/portfolio-panel';
import { YourNftsPill } from '@/components/your-nfts-sheet';
import { PriceTicker } from '@/components/price-ticker';
import { UpdateBanner } from '@/components/update-banner';
import { TopNav } from '@/components/top-nav';
import { C } from '@/constants/brand';
import { AlertsProvider } from '@/lib/alerts';
import { pageview } from '@/lib/analytics';
import { AuthProvider } from '@/lib/auth';
import { EvmWalletProvider } from '@/lib/evm-wallet';
import { useLayout } from '@/lib/layout';
import { PanelProvider, usePanel } from '@/lib/panel';
import { PricesProvider } from '@/lib/prices';
import { ProfileProvider } from '@/lib/profile';
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
      <ProfileProvider>
      <AlertsProvider>
      <WalletProvider>
      <EvmWalletProvider>
      <TradeModeProvider>
      <PanelProvider>
      <PricesProvider>
        <StatusBar style="light" />
        <Pageviews />
        <AnimatedSplashOverlay />
        <Shell>
          <Stack screenOptions={{ contentStyle: { backgroundColor: C.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* Web draws its own header (TopNav) on these pages */}
            <Stack.Screen name="wallet/[address]" options={{ title: 'Wallet', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="collection/[symbol]" options={{ title: 'Collection', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="item/[symbol]/[id]" options={{ title: 'NFT', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="drop/[slug]" options={{ title: 'Mint', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="alerts" options={{ title: 'Alerts', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="create/index" options={{ title: 'Launch', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="create/[id]" options={{ title: 'Collection', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="c/[chain]/[address]" options={{ title: 'Mint', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="history" options={{ title: 'History', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="support" options={{ title: 'Support', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="how-it-works" options={{ title: 'How it works', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="profile" options={{ title: 'Profile', headerBackTitle: 'Back', headerShown: !web }} />
            <Stack.Screen name="settings" options={{ title: 'Settings', headerBackTitle: 'Back', headerShown: !web }} />
          </Stack>
        </Shell>
        <UpdateBanner />
        <AccountSetup />
      </PricesProvider>
      </PanelProvider>
      </TradeModeProvider>
      </EvmWalletProvider>
      </WalletProvider>
      </AlertsProvider>
      </ProfileProvider>
      </SessionProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

// One page view per route change (web; see lib/analytics.ts).
function Pageviews() {
  const path = usePathname();
  useEffect(() => pageview(path), [path]);
  return null;
}

// Wide web: one header across the top, the discovery panel on the left, the
// page in the middle, the portfolio glance on the right (widest windows), and
// the price ticker along the bottom. Elsewhere the page
// draws its own chrome (pages render TopNav as a back bar on narrow web).
function Shell({ children }: { children: React.ReactNode }) {
  const { wide } = useLayout();
  const panel = usePanel();
  const path = usePathname();
  if (!web || !wide) return <>{children}</>;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <TopNav />
      <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
        {panel.available && <DiscoveryPanel />}
        <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
        {panel.right.available && <PortfolioPanel />}
      </View>
      <PriceTicker />
      {/* Too narrow for the right panel: the floating pill instead. */}
      {!panel.right.available && !path.startsWith('/portfolio') && <YourNftsPill bottom={48} />}
    </View>
  );
}
