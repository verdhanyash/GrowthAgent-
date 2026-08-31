/** @type {import('tailwindcss').Config} */
// Dark mission-control theme per frontend-events.md §6 — single committed dark
// theme; explicit backgrounds everywhere, never transparent bodies.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1120", // page ground
        panel: "#111a2e", // cards/panels
        edge: "#1e293b", // borders
        ink: "#e2e8f0", // primary text
        mute: "#64748b", // secondary text
        accent: "#22d3ee", // cyan — running/live highlights
        ok: "#34d399", // PASS / APPROVE green
        warn: "#fbbf24", // BAND amber
        bad: "#f87171", // FAIL / DECLINE / injection red
        escalate: "#c084fc", // ESCALATE / awaiting-human violet
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
