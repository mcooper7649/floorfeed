import { useEffect, useState } from 'react';
import { Animated, PanResponder, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

// Drag a bottom sheet down to close it. The drag can start anywhere on the
// sheet while its content is scrolled to the top (otherwise the content
// scrolls); pulling past a third of the way, or flicking down, closes it,
// anything less springs back. Spread `panHandlers` on the sheet, put `style`
// on it (an Animated.View), and pass `onScroll` to its ScrollView.
export function useSwipeDown(onClose: () => void, enabled = true) {
  const [sw] = useState(makeSwipe);
  useEffect(() => sw.setOnClose(onClose), [sw, onClose]);
  return {
    panHandlers: enabled ? sw.panHandlers : {},
    style: sw.style,
    onLayout: sw.onLayout,
    onScroll: sw.onScroll,
  };
}

// The gesture's state lives outside React: it only matters inside handlers.
function makeSwipe() {
  const y = new Animated.Value(0);
  let scrollTop = 0;
  let height = 400;
  let onClose = () => {};
  const back = () => Animated.spring(y, { toValue: 0, useNativeDriver: false, bounciness: 4 }).start();
  const responder = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => scrollTop <= 0 && g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
    onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > height / 3 || g.vy > 0.6) {
        Animated.timing(y, { toValue: height, duration: 160, useNativeDriver: false }).start(() => {
          onClose();
          y.setValue(0);
        });
      } else back();
    },
    onPanResponderTerminate: back,
  });
  return {
    panHandlers: responder.panHandlers,
    style: { transform: [{ translateY: y }] },
    setOnClose: (f: () => void) => { onClose = f; },
    onLayout: (e: { nativeEvent: { layout: { height: number } } }) => { height = e.nativeEvent.layout.height; },
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { scrollTop = e.nativeEvent.contentOffset.y; },
  };
}
