/**
 * web/src/screens/PolicyScreen.tsx — everything that CONFIGURES the system, in
 * one place: the deterministic rules, their changelog, and who holds a key.
 *
 * Agents used to be their own top-level screen showing six cards to say six
 * things ("here is a key prefix"). It is a config surface used a handful of
 * times, not an operational one, so it belongs beside the rules rather than
 * beside Analytics — that is one fewer thing in the nav and one less place to
 * look. The revoke control itself is unchanged; it is a real security action.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgents,
  fetchRules,
  fetchRulesHistory,
  revokeAgent,
  updateRules,
} from "../lib/admin-api.js";
import {
  formatPaise,
  type AdminAgent,
  type AdminRulesResponse,
  type RulesHistoryEntry,
} from "@growthagent/shared";
import {
  Button,
  Chip,
  DataTable,
  Empty,
  Field,
  KV,
  Page,
  Section,
  Segmented,
  inputClass,
} from "../components/ui.js";

type Tab = "RULES" | "HISTORY" | "ACCESS";

const TABS: readonly { value: Tab; label: string }[] = [
  { value: "RULES", label: "Rules" },
  { value: "HISTORY", label: "Changelog" },
  { value: "ACCESS", label: "Access" },
];

export function PolicyScreen(): JSX.Element {
  const [tab, setTab] = useState<Tab>("RULES");
  const qc = useQueryClient();

  const { data: rules } = useQuery({ queryKey: ["admin", "rules"], queryFn: fetchRules });
  const { data: history } = useQuery({
    queryKey: ["admin", "rules", "history"],
    queryFn: fetchRulesHistory,
    enabled: tab === "HISTORY",
  });
  const { data: agents } = useQuery({
    queryKey: ["admin", "agents"],
    queryFn: fetchAgents,
    enabled: tab === "ACCESS",
  });

  return (
    <Page
      title="Policy"
      description="The gatekeeper evaluates these parameters on every cart. The AI proposes; nothing here is negotiable."
      actions={<Segmented options={TABS} value={tab} onChange={setTab} label="Policy view" />}
    >
      {tab === "RULES" &&
        (rules === undefined ? (
          <Empty>Loading policy…</Empty>
        ) : (
          <RulesTab
            data={rules}
            onUpdated={() => {
              void qc.invalidateQueries({ queryKey: ["admin", "rules"] });
            }}
          />
        ))}

      {tab === "HISTORY" &&
        (history === undefined ? (
          <Empty>Loading changelog…</Empty>
        ) : history.length === 0 ? (
          <Empty>No policy change has been recorded yet.</Empty>
        ) : (
          <Section hint="Append-only. A row marked “raised” relaxed a cap and required an explicit confirmation.">
            <div className="space-y-3">
              {history.map((h) => (
                <HistoryRow key={h.rules_version} entry={h} />
              ))}
            </div>
          </Section>
        ))}

      {tab === "ACCESS" && <AccessTab agents={agents} />}
    </Page>
  );
}

/* --------------------------------- rules ---------------------------------- */

function RulesTab({
  data,
  onUpdated,
}: {
  data: AdminRulesResponse;
  onUpdated: () => void;
}): JSX.Element {
  const r = data.rules;
  const [maxDiscount, setMaxDiscount] = useState(String(r.max_discount_pct));
  const [maxCartRupees, setMaxCartRupees] = useState(String(Math.floor(r.max_cart_value_paise / 100)));
  const [marginFloor, setMarginFloor] = useState(String(r.margin_floor_pct));
  const [note, setNote] = useState("");
  const [confirmIncrease, setConfirmIncrease] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      updateRules(
        {
          max_discount_pct: Number(maxDiscount),
          max_cart_value_paise: Number(maxCartRupees) * 100,
          margin_floor_pct: Number(marginFloor),
        },
        data.rules_version,
        confirmIncrease,
        note,
      ),
    onSuccess: (d) => {
      setMsg({ ok: true, text: `Now enforcing v${d.rules_version}.` });
      setNote("");
      setConfirmIncrease(false);
      onUpdated();
    },
    onError: (e: unknown) =>
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  // A "relaxation" is any edit that lets more through than the live policy does.
  // The API demands an explicit confirm for exactly these, so the UI has to name
  // them rather than let the request fail with a code the operator must decode.
  const relaxing =
    Number(maxDiscount) > r.max_discount_pct ||
    Number(maxCartRupees) * 100 > r.max_cart_value_paise ||
    Number(marginFloor) < r.margin_floor_pct;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="In force" hint={`Version ${data.rules_version} · updated ${new Date(data.updated_at).toLocaleString()}`}>
        <dl className="divide-y divide-edge/60 rounded-xl border border-edge bg-panel px-6 py-2">
          <KV k="Max discount">{r.max_discount_pct}%</KV>
          <KV k="Max cart value">{formatPaise(r.max_cart_value_paise)}</KV>
          <KV k="Margin floor">{r.margin_floor_pct}%</KV>
          <KV k="Categories">{r.category_allowlist.join(", ") || "all"}</KV>
          <KV k="Velocity">
            {r.per_agent_velocity.max_requests_per_hour}/hr ·{" "}
            {formatPaise(r.per_agent_velocity.max_value_per_day_paise)}/day
          </KV>
          <KV k="Expired stock">{r.expiry_policy.block_expired_skus ? "blocked" : "allowed"}</KV>
        </dl>
      </Section>

      <Section title="Change" hint="Guarded by the live version — a concurrent edit is refused, never merged silently.">
        <form
          className="space-y-5 rounded-xl border border-edge bg-panel p-6"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max discount %">
              <input
                type="number"
                min="0"
                max="100"
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Max cart ₹">
              <input
                type="number"
                min="1"
                value={maxCartRupees}
                onChange={(e) => setMaxCartRupees(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Margin floor %">
              <input
                type="number"
                min="0"
                max="100"
                value={marginFloor}
                onChange={(e) => setMarginFloor(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Reason" hint="recorded in the changelog">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this change?"
              className={inputClass}
            />
          </Field>

          {relaxing && (
            <label className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 p-4 text-[12px] text-warn-bright">
              <input
                type="checkbox"
                checked={confirmIncrease}
                onChange={(e) => setConfirmIncrease(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                This relaxes a cap — more carts will pass without a human. Confirm to proceed.
              </span>
            </label>
          )}

          {msg !== null && (
            <p className={`text-[12px] ${msg.ok ? "text-ok-bright" : "text-bad-bright"}`}>
              {msg.text}
            </p>
          )}

          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? "Applying…" : `Commit as v${data.rules_version + 1}`}
          </Button>
        </form>
      </Section>
    </div>
  );
}

function HistoryRow({ entry }: { entry: RulesHistoryEntry }): JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={entry.increase ? "warn" : "default"}>v{entry.rules_version}</Chip>
          <span className="text-[12px] text-ink-muted">{entry.actor}</span>
          {entry.increase && <Chip tone="warn">cap raised</Chip>}
        </div>
        <span className="text-[11px] text-mute">
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      {entry.note !== null && entry.note !== undefined && entry.note !== "" && (
        <p className="mt-2 text-[12px] text-ink-muted">{entry.note}</p>
      )}
    </div>
  );
}

/* --------------------------------- access --------------------------------- */

/**
 * Key holders as a table, not six cards. Only the prefix is ever shown — the
 * API stores a hash, so the plaintext key does not exist to be leaked here.
 */
function AccessTab({ agents }: { agents: readonly AdminAgent[] | undefined }): JSX.Element {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (v: { id: string; reason: string }) => revokeAgent(v.id, v.reason),
    onSuccess: (a) => {
      setMsg(`Revoked ${a.agent_id}. Its next request fails closed.`);
      setPendingId(null);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["admin", "agents"] });
    },
    onError: (e: unknown) => setMsg(e instanceof Error ? e.message : String(e)),
  });

  if (agents === undefined) return <Empty>Loading agents…</Empty>;

  return (
    <Section hint="Revocation takes effect on the agent's next request — there is no grace period.">
      {msg !== null && <p className="mb-3 text-[12px] text-ink-muted">{msg}</p>}

      <div className="rounded-xl border border-edge bg-panel px-6 py-2">
        <DataTable<AdminAgent>
          rows={agents}
          rowKey={(a) => a.agent_id}
          columns={[
            {
              header: "Agent",
              cell: (a) => (
                <div>
                  <div className="text-[12px] text-ink">{a.display_name}</div>
                  <div className="text-[10px] text-mute">{a.agent_id}</div>
                </div>
              ),
            },
            { header: "Role", cell: (a) => a.role },
            {
              header: "Key",
              cell: (a) => (
                <span className="font-mono text-[11px] text-mute">{a.api_key_prefix}••••</span>
              ),
            },
            {
              header: "Status",
              cell: (a) =>
                a.revoked_at === null || a.revoked_at === undefined ? (
                  <Chip tone="ok">active</Chip>
                ) : (
                  <Chip tone="bad" title={a.revoked_reason ?? undefined}>
                    revoked
                  </Chip>
                ),
            },
            {
              header: "",
              cell: (a) =>
                a.revoked_at !== null && a.revoked_at !== undefined ? (
                  <span className="text-[11px] text-mute">
                    {new Date(a.revoked_at).toLocaleDateString()}
                  </span>
                ) : pendingId === a.agent_id ? (
                  <div className="flex items-center justify-end gap-2">
                    <input
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason"
                      aria-label={`Reason for revoking ${a.agent_id}`}
                      className={`${inputClass} w-40`}
                    />
                    <Button
                      variant="danger"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ id: a.agent_id, reason })}
                    >
                      Confirm
                    </Button>
                    <Button onClick={() => setPendingId(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="text-right">
                    <Button
                      onClick={() => {
                        setPendingId(a.agent_id);
                        setReason("");
                        setMsg(null);
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </div>
    </Section>
  );
}
