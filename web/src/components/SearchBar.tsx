/**
 * web/src/components/SearchBar.tsx
 *
 * Full-featured interactive Global Search Bar.
 * - Global Ctrl+K / Cmd+K hotkey
 * - Live search across navigation pages, Gatekeeper invariants, and transaction records
 * - Keyboard navigation (Escape to close, click to navigate)
 */
import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchTransactions } from "../lib/admin-api.js";

const PAGES = [
  { label: "Analytics", to: "/", desc: "Operational control center, metrics & ledger" },
  { label: "Pipeline Topology", to: "/pipeline", desc: "Interactive connected graph & 3D view" },
  { label: "Transactions", to: "/transactions", desc: "Complete execution ledger and filters" },
  { label: "Approvals", to: "/approvals", desc: "Human escalation inbox & capability tokens" },
  { label: "Policy & Invariants", to: "/policy", desc: "Gatekeeper rules editor & access control" },
  { label: "Scenario Simulator", to: "/simulate", desc: "1-Click test runs & custom proposal composer" },
  { label: "Operations Guide", to: "/guide", desc: "16 invariant formulas & architecture guide" },
];

const RULES = [
  { id: "GK-DISCOUNT-CAP", name: "Discount Ceiling", desc: "Max discount cap (default 15%)" },
  { id: "GK-MARGIN-FLOOR", name: "Gross Margin Floor", desc: "Order gross margin floor (default 25%)" },
  { id: "GK-INJECTION-GUARD", name: "Prompt Injection Sentinel", desc: "Detects adversarial prompts in notes" },
  { id: "GK-HIGH-VALUE-ESCALATE", name: "High-Value Escalation", desc: "Routes large carts to human approvals" },
  { id: "GK-STOCK-AVAIL", name: "Stock Availability", desc: "Prevents overselling scarce inventory" },
  { id: "GK-TOTALS-DRIFT", name: "Integer Paise Arithmetic", desc: "Strict integer math without float drift" },
  { id: "GK-MIN-CART-VALUE", name: "Minimum Cart Value", desc: "Floor requirement covering packaging/fees" },
  { id: "GK-VELOCITY-CHECK", name: "Agent Velocity Check", desc: "Limits order frequency per buyer" },
];

export function SearchBar(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  // Search transactions query
  const { data: txData } = useQuery({
    queryKey: ["admin", "transactions", "search", query],
    queryFn: () => fetchTransactions({ q: query, limit: 4 }),
    enabled: open && query.trim().length > 1,
  });

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const q = query.toLowerCase().trim();

  const matchingPages = PAGES.filter(
    (p) => q === "" || p.label.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
  );

  const matchingRules = RULES.filter(
    (r) => q === "" || r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)
  );

  const matchingTxs = txData?.transactions ?? [];

  const handleSelect = (to: string) => {
    nav(to);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      {/* Search Input Bar */}
      <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 transition-colors focus-within:border-white/30 hover:border-white/20">
        <svg
          className="mr-2 h-3.5 w-3.5 text-neutral-400 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search..."
          className="w-28 bg-transparent text-[12px] text-white placeholder-neutral-400 outline-none transition-all sm:w-44 md:w-56"
        />
        <kbd className="hidden rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-neutral-400 sm:inline-block">
          Ctrl K
        </kbd>
      </div>

      {/* Floating Results Palette */}
      {open && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-2 w-[340px] sm:w-[420px] rounded-xl border border-neutral-800 bg-[#0c0c0c] p-2 shadow-2xl z-50 max-h-[440px] overflow-y-auto"
        >
          {/* Section 1: Navigation Pages */}
          <div className="mb-2">
            <span className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
              Pages
            </span>
            <div className="mt-1 space-y-0.5">
              {matchingPages.slice(0, 4).map((page) => (
                <button
                  key={page.to}
                  type="button"
                  onClick={() => handleSelect(page.to)}
                  className="w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.08]"
                >
                  <div>
                    <span className="text-[12px] font-medium text-white">{page.label}</span>
                    <p className="text-[11px] text-neutral-400">{page.desc}</p>
                  </div>
                  <span className="font-mono text-[10px] text-neutral-400">Jump →</span>
                </button>
              ))}
            </div>
          </div>

          {/* Section 2: Gatekeeper Rules */}
          {matchingRules.length > 0 && (
            <div className="mb-2 border-t border-neutral-800/80 pt-2">
              <span className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                Gatekeeper Invariants
              </span>
              <div className="mt-1 space-y-0.5">
                {matchingRules.slice(0, 3).map((rule) => (
                  <button
                    key={rule.id}
                    type="button"
                    onClick={() => handleSelect("/guide")}
                    className="w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.08]"
                  >
                    <div>
                      <span className="font-mono text-[11px] font-semibold text-white">{rule.id}</span>
                      <p className="text-[11px] text-neutral-400">{rule.name} · {rule.desc}</p>
                    </div>
                    <span className="font-mono text-[10px] text-neutral-400">Rule →</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Section 3: Transactions */}
          {matchingTxs.length > 0 && (
            <div className="border-t border-neutral-800/80 pt-2">
              <span className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                Matching Transactions
              </span>
              <div className="mt-1 space-y-0.5">
                {matchingTxs.map((tx) => (
                  <button
                    key={tx.tx_id}
                    type="button"
                    onClick={() => handleSelect(`/trace/${tx.tx_id}`)}
                    className="w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.08]"
                  >
                    <div>
                      <span className="font-mono text-[11px] text-neutral-200">
                        {tx.tx_id.slice(0, 18)}...
                      </span>
                      <p className="text-[10px] text-neutral-400">
                        {tx.agent_id} · {tx.outcome ?? "In flight"}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-neutral-400">Trace →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
