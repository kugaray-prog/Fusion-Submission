// Design tokens matching the dashboard's CSS variables.
export const colors = {
  // Brand
  primary: '#0D00A5',
  primaryHover: '#09007A',
  primaryLight: '#F0F2FF',
  secondary: '#2B3674',
  accent: '#4318FF',

  // Legacy aliases.
  cspcBlue: '#0D00A5',
  cspcBlueLight: '#2B3674',
  cspcGold: '#0D00A5',

  // Status
  success: '#05CD99',
  successBg: '#DCFCE7',
  successText: '#04946F',
  error: '#EE5D50',
  danger: '#EE5D50',
  dangerBg: '#FEE2E2',
  dangerText: '#C0392B',
  warning: '#FFB547',
  warningBg: '#FFF4E5',
  warningText: '#B25E00',
  info: '#4338CA',
  infoBg: '#E0E7FF',
  infoText: '#4338CA',

  // Legacy status aliases
  waitingBg: '#FFF4E5',
  waitingText: '#B25E00',
  soonBg: '#E0E7FF',
  soonText: '#4338CA',

  // Neutrals
  bg: '#F4F7FE',
  white: '#FFFFFF',
  textMain: '#1B2559',
  textSub: '#A3AED0',
  border: '#E9EDF7',
};

export const radius = {
  xl: 24,
  lg: 18,
  md: 14,
  sm: 10,
  pill: 999,
};

// Soft, low elevation -- mirrors the admin dashboard's --shadow-sm.
export const shadow = {
  shadowColor: '#7090B0',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.12,
  shadowRadius: 12,
  elevation: 2,
};

// Stronger lift for the one hero card per screen and floating elements.
export const shadowLg = {
  shadowColor: '#0D00A5',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.22,
  shadowRadius: 20,
  elevation: 6,
};

// Type scale shared by every screen, so headings and labels line up.
export const type = {
  title: { fontSize: 22, fontWeight: '700', color: colors.textMain, letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: '700', color: colors.textMain, letterSpacing: -0.2 },
  body: { fontSize: 14, fontWeight: '500', color: colors.textMain },
  caption: { fontSize: 12, fontWeight: '500', color: colors.textSub },
  overline: { fontSize: 11, fontWeight: '700', color: colors.textSub, letterSpacing: 0.6, textTransform: 'uppercase' },
};

export const CSPC_LOGO = require('../assets/cspc-logo.png');

export default { colors, radius, shadow, shadowLg, type, CSPC_LOGO };
