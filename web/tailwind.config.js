/** @type {import('tailwindcss').Config} */

/**
 * Only the tokens the app actually uses. The previous config carried 24 colours
 * of which nine were never referenced — including three `*-dark` steps and an
 * `accent` that was just white again. A theme you cannot hold in your head is a
 * theme that drifts.
 *
 * Two surfaces (pitch-black page, one step up for cards), two hairlines, three
 * inks, four status hues plus a brighter step of each for text.
 *
 * The four status hues are THE SAME four the charts use (src/lib/viz.ts), mapped
 * to the same meanings — approved/green, escalated/amber, declined/red,
 * failed/orange — so the reader learns one colour language and a chip beside a
 * chart segment agrees with it. Those hexes were validated for ≥3:1 against the
 * card surface and for colour-vision separation as a set; the `*-bright` steps
 * here are the text-safe variants, all ≥4.5:1 on #0a0a0a:
 *   ok 5.9 · ok-bright 9.1 · warn 7.5 · warn-bright 9.6
 *   bad 4.1 · bad-bright 6.6 · escalate 10.8 · escalate-bright 12.4
 *   ink 21 · ink-muted 7.9 · mute 5.5
 * Chart colours themselves stay in viz.ts, not here: a Tailwind class is the
 * wrong home for a number that has a validator run attached to it.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /* surfaces */
        canvas: "#000000",
        panel: "#0a0a0a",
        /* hairlines */
        edge: "#1f1f1f",
        "edge-bright": "#333333",
        /* ink */
        ink: "#ffffff",
        "ink-muted": "#a3a3a3",
        mute: "#878787",
        /* status — meaning, never decoration */
        ok: "#0ca30c",
        "ok-bright": "#3ec93e",
        escalate: "#fab219",
        "escalate-bright": "#fbc44d",
        bad: "#d03b3b",
        "bad-bright": "#e97070",
        warn: "#ec835a",
        "warn-bright": "#f0a184",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
