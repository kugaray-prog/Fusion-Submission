import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Tablet = short side >= 600dp.
const TABLET_MIN_SHORT_SIDE = 600;
const WIDE_MIN_WIDTH = 900;
const COMPACT_MAX_HEIGHT = 500;

// Max content widths.
export const MAX_WIDTH = { form: 520, content: 720, wide: 1100 };

// Allow every Modal in landscape on iOS.
export const MODAL_ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'];

export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;
  const isTablet = Math.min(width, height) >= TABLET_MIN_SHORT_SIDE;
  const isWide = width >= WIDE_MIN_WIDTH;
  const isCompactHeight = height < COMPACT_MAX_HEIGHT;
  const gutter = isTablet ? 32 : 20;

  // Centered, width-capped column for a screen's content. The side padding
  // also clears the notch / rounded corners of a phone held in landscape.
  const contentStyle = (maxWidth = MAX_WIDTH.content) => ({
    width: '100%',
    maxWidth: maxWidth + gutter * 2 + insets.left + insets.right,
    alignSelf: 'center',
    paddingLeft: gutter + insets.left,
    paddingRight: gutter + insets.right,
  });

  // Top padding for screens without a native header: clears the status bar
  // (the app draws edge-to-edge) while keeping the usual 20dp on phones.
  const topPad = Math.max(gutter, insets.top + 12);

  return { width, height, insets, isLandscape, isTablet, isWide, isCompactHeight, gutter, topPad, contentStyle };
}
