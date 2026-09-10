import type { Config } from 'tailwindcss';

// Single Tailwind config + single design-token set for the app (SPEC §2).
//
// Design direction: a calm, light habit tracker where the ONE memorable element is
// the streak — the flame. Everything around it is quiet: warm off-white paper, a deep
// evergreen surface, a single amber "fire" accent, and a restrained set of semantic
// status colors. Typography is one display face (Space Grotesk) for headings/numbers
// and one body face (Inter). Every token defined here is used in markup.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces & text
        paper: '#faf9f6',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#1d221f',
          soft: '#5c665f',
          faint: '#98a29a',
        },
        line: '#e6e7e0',
        // Brand + fire
        evergreen: {
          DEFAULT: '#1f5c4d',
          deep: '#16463b',
        },
        fire: {
          DEFAULT: '#e8562b',
          soft: '#fdeee6',
        },
        // Semantic status
        leaf: { DEFAULT: '#1f7a52', soft: '#e6f4ec' },
        amber: { DEFAULT: '#b5760f', soft: '#f8f0dd' },
        stone: { DEFAULT: '#6b7280', soft: '#f0f1ef' },
        // Form states
        danger: { DEFAULT: '#c23b3b', soft: '#fbecec', ring: '#f2b8b8' },
        focus: '#1f5c4d',
      },
      fontFamily: {
        // One heading font (font-display) + one body font (font-body).
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // One soft, consistent card shadow (the quiet default).
        card: '0 1px 2px rgba(29,34,31,0.04), 0 8px 24px rgba(29,34,31,0.06)',
        // A slightly lifted shadow for modals / toasts.
        lift: '0 2px 4px rgba(29,34,31,0.06), 0 20px 48px rgba(29,34,31,0.14)',
      },
      keyframes: {
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(-8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'sheet-in': {
          '0%': { transform: 'translateY(16px)' },
          '100%': { transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'toast-in': 'toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'sheet-in': 'sheet-in 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.18s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
