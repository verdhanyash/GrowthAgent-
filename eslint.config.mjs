// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "web/**"] },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  // Purity enforcement for the money gate (gatekeeper.md §16.4): no clock,
  // no randomness, no network, no process access inside src/gatekeeper/**.
  // (Date.parse on INPUT strings is allowed — deterministic; only the
  // parameterless clock forms are banned. Tests are exempt from the
  // process-access clause only — they need hrtime for the latency budget.)
  {
    files: ["api/src/gatekeeper/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "gatekeeper is pure: Date.now() is a clock — take time via input.now_iso.",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: "gatekeeper is pure: `new Date()` reads the clock — parse input ISO strings instead.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "gatekeeper is pure: Math.random() breaks determinism (invariant I-1).",
        },
        {
          selector: "MemberExpression[object.name='process']",
          message: "gatekeeper is pure: process access forbidden inside the gate.",
        },
        {
          selector: "AwaitExpression",
          message: "gatekeeper is synchronous and IO-free — no await inside the gate.",
        },
      ],
    },
  },
  {
    files: ["api/src/gatekeeper/__tests__/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "gatekeeper tests stay deterministic too — pin time via fixtures.",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: "gatekeeper tests stay deterministic too — use fixture timestamps.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "gatekeeper tests stay deterministic — use fast-check generators.",
        },
      ],
    },
  },
);
