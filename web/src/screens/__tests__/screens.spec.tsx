/**
 * screens.spec.tsx — render tests for every screen in the app.
 *
 * These are smoke tests with teeth: each screen is mounted with its real query
 * client (network absent, so the loading/empty branches run) and asserted on the
 * things a refactor is most likely to silently break — that the screen renders
 * at all, that its heading is there, and that its controls exist. The
 * data-bearing paths are covered by the API's own specs, which assert against a
 * real Postgres rather than a mock.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AnalyticsScreen } from "../AnalyticsScreen.js";
import { TransactionsScreen } from "../TransactionsScreen.js";
import { ApprovalsScreen } from "../ApprovalsScreen.js";
import { PolicyScreen } from "../PolicyScreen.js";
import { SimulateScreen } from "../SimulateScreen.js";

afterEach(cleanup);

function withProviders(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AnalyticsScreen", () => {
  it("renders the heading and the one filter row that scopes every panel", () => {
    render(withProviders(<AnalyticsScreen />));
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeTruthy();
    // Exactly one time-range control: per-chart filters are the anti-pattern.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    for (const label of ["24 hours", "7 days", "30 days"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it("shows the four headline figures rather than a wall of cards", () => {
    render(withProviders(<AnalyticsScreen />));
    for (const label of ["Proposals", "Approval rate", "Decision time", "Approved value"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("names every chart panel", () => {
    render(withProviders(<AnalyticsScreen />));
    for (const title of [
      "Volume over time",
      "Outcome mix",
      "Rules that intervened",
      "Stage latency",
      "Settlement",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
  });
});

describe("TransactionsScreen", () => {
  it("renders search + outcome filters and an honest empty state", () => {
    render(withProviders(<TransactionsScreen />));
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeTruthy();
    expect(screen.getByLabelText(/search transactions/i)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Approved" })).toBeTruthy();
  });
});

describe("ApprovalsScreen", () => {
  it("renders both queue tabs", () => {
    render(withProviders(<ApprovalsScreen />));
    expect(screen.getByRole("heading", { name: "Approvals" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /waiting/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /decided/i })).toBeTruthy();
  });
});

describe("PolicyScreen", () => {
  it("folds rules, changelog and access into one screen", () => {
    render(withProviders(<PolicyScreen />));
    expect(screen.getByRole("heading", { name: "Policy" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rules" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Changelog" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Access" })).toBeTruthy();
  });
});

describe("SimulateScreen", () => {
  it("lists the five scripted scenarios exactly once each", () => {
    render(withProviders(<SimulateScreen />));
    expect(screen.getByRole("heading", { name: "Simulate" })).toBeTruthy();
    for (const name of [
      "Ordinary buyer",
      "Prompt injection",
      "High-value cart",
      "LLM timeout",
      "Gateway outage",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // One Run button per scenario — the old app offered the same three
    // scenarios on two different screens under two different names.
    expect(screen.getAllByRole("button", { name: "Run" })).toHaveLength(5);
  });

  it("keeps the custom composer and hides the destructive controls", () => {
    render(withProviders(<SimulateScreen />));
    expect(screen.getByText(/What does the buyer want\?/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reset to pristine/i })).toBeNull();
    expect(screen.getByRole("button", { name: /fault injection and reset/i })).toBeTruthy();
  });
});
