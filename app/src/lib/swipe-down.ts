import { useEffect, useState } from 'react';
import { Animated, Dimensions, PanResponder, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

// A bottom sheet that slides up when opened and can be dragged down to close.
// The drag can start anywhere on the sheet while its content is scrolled to
// the top (otherwise the content scrolls); pulling past a third of the way, or
// flicking down, closes it, anything less springs back.
//
// The sheet does its own sliding, so render its Modal with animationType
// "none": a Modal slide on top of this one plays a second animation (the sheet
// jumps back up, then slides out again). Spread `panHandlers` on the sheet (an
// Animated.View) with `style`, put `backdropStyle` on the backdrop's
// Animated.View, pass `onScroll` to its ScrollView, and close with `dismiss`.
export function useSwipeDown(open: boolean, onClose: () => void, enabled = true) {
  const [sw] = useState(makeSwipe);
  useEffect(() => sw.setOnClose(onClose), [sw, onClose]);
  useEffect(() => { if (open && enabled) sw.enter(); }, [sw, open, enabled]);
  return {
    panHandlers: enabled ? sw.panHandlers : {},
    style: enabled ? sw.style : null,
    backdropStyle: enabled ? sw.backdropStyle : null,
    onLayout: sw.onLayout,
    onScroll: sw.onScroll,
    dismiss: enabled ? sw.dismiss : onClose,
  };
}

// The gesture's state lives outside React: it only matters inside handlers.
function makeSwipe() {
  const screen = Dimensions.get('window').height;
  const y = new Animated.Value(screen);
  let scrollTop = 0;
  let height = screen;
  let onClose = () => {};
  const back = () => Animated.spring(y, { toValue: 0, useNativeDriver: false, bounciness: 4 }).start();
  // Slides out, then closes. It parks where enter() starts from, so reopening
  // doesn't jump.
  const dismiss = () => {
    Animated.timing(y, { toValue: Math.max(height, screen), duration: 200, useNativeDriver: false }).start(({ finished }) => {
      if (finished) onClose();
    });
  };
  const responder = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => scrollTop <= 0 && g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
    onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > height / 3 || g.vy > 0.6) dismiss();
      else back();
    },
    onPanResponderTerminate: back,
  });
  return {
    panHandlers: responder.panHandlers,
    style: { transform: [{ translateY: y }] },
    backdropStyle: { opacity: y.interpolate({ inputRange: [0, screen], outputRange: [1, 0], extrapolate: 'clamp' }) },
    setOnClose: (f: () => void) => { onClose = f; },
    enter: () => {
      scrollTop = 0;
      y.setValue(screen);
      Animated.timing(y, { toValue: 0, duration: 240, useNativeDriver: false }).start();
    },
    dismiss,
    onLayout: (e: { nativeEvent: { layout: { height: number } } }) => { height = e.nativeEvent.layout.height; },
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { scrollTop = e.nativeEvent.contentOffset.y; },
  };
}
