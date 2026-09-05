import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type AskResult,
  type Bridge,
  type HelperBucket,
  type HelperCandidate,
  type HelperReview,
  type HelperRoster,
  type ProvisionResult,
} from "../api";
import { fmtDate } from "./common";

/**
 * The helper roster for one bridge: who is in its helper channel, what provisioning each of
 * them would actually do in Chatwoot, and the history of what has been done.
 *
 * Two rules shape this screen. Nothing is provisioned by looking — reviewing is a read, and
 * provisioning always names the exact people. And people whose Chatwoot user does not exist yet
 * start unticked, because those are the ones that turn a channel invite into a Chatwoot invite.
 */
export function HelpersPanel({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
  const [roster, setRoster] = useState<HelperRoster | null>(null);
  const [review, setReview] = useState<HelperReview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<(ProvisionResult | AskResult)[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    try {
      setRoster(await api.get<HelperRoster>(`/bridges/${bridge.id}/helpers`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [bridge.id]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await loadRoster();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  async function doReview() {
    await run("review", async () => {
      const r = await api.post<HelperReview>(`/bridges/${bridge.id}/helpers/review`);
      setReview(r);
      setResults(null);
      // Tick everyone there is something to do for. Which "something" it is depends on the bucket:
      // the two buttons below act on the halves of the selection they apply to, never on both.
      setPicked(new Set(r.candidates.filter(actionable).map((c) => c.slackUserId)));
    });
  }

  /** Both actions send the exact list shown on the button, and re-read the roster afterwards. */
  async function act(what: "provision" | "ask", ids: string[]) {
    await run(what, async () => {
      const r = await api.post<{ results: (ProvisionResult | AskResult)[] }>(`/bridges/${bridge.id}/helpers/${what}`, { slackUserIds: ids, expected: ids.length });
      setResults(r.results);
      setPicked(new Set());
      setReview(await api.post<HelperReview>(`/bridges/${bridge.id}/helpers/review`));
    });
  }

  // The selection is one set; each button acts only on the part of it that button can act on.
  const chosen = useMemo(() => (review?.candidates ?? []).filter((c) => picked.has(c.slackUserId)), [review, picked]);
  const toProvision = useMemo(() => chosen.filter((c) => c.bucket === "existing" || c.bucket === "member"), [chosen]);
  const toAsk = useMemo(() => chosen.filter(askable), [chosen]);

  const overBatch = review ? Math.max(toProvision.length, toAsk.length) > review.maxBatch : false;
  const noProvisioning = review && (!review.canProvision || !review.serviceToken.canProvision);
  const noAsking = !roster?.canProvision || !roster.linkPrompt;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Helpers on {bridge.name}</h3>
        <button className="small" onClick={onClose}>
          Close
        </button>
      </div>

      {!bridge.helperChannel ? (
        <p className="note">
          This bridge has no helper channel. Set one in <strong>Edit</strong> → <em>Helpers</em>: its members are tracked here, and can be given Chatwoot agent
          accounts on this bridge&apos;s account.
        </p>
      ) : (
        <>
          <p className="note">
            Watching <code>{bridge.helperChannel}</code>. New joiners:{" "}
            <strong>
              {bridge.helperAutoProvision === "off"
                ? "recorded, provisioned by hand"
                : bridge.helperAutoProvision === "existing"
                  ? "provisioned automatically if Chatwoot already knows them"
                  : "provisioned automatically, invitations included"}
            </strong>
            . Leavers: <strong>{bridge.helperOffboarding === "unlink" ? "taken off the Chatwoot account" : "recorded only"}</strong>. A Chatwoot user is never
            deleted — the most that happens is losing access to this account.
          </p>

          {roster?.paused && (
            <p className="err">
              Auto-provisioning is paused since {fmtDate(roster.paused.at)}: {roster.paused.reason}{" "}
              {roster.canProvision && (
                <button className="small" disabled={busy !== null} onClick={() => void run("resume", () => api.post(`/bridges/${bridge.id}/helpers/resume`))}>
                  Resume
                </button>
              )}
            </p>
          )}
          {err && <p className="err">{err}</p>}

          <div className="row" style={{ margin: "12px 0" }}>
            <button className="primary" disabled={busy !== null} onClick={() => void doReview()}>
              {busy === "review" ? "Reading the channel…" : review ? "Review again" : "Review the channel"}
            </button>
            <span className="note">Reads Slack and Chatwoot and shows what each person would get. Provisions nobody.</span>
          </div>

          {review && (
            <>
              {!review.serviceToken.canProvision && (
                <p className="err">
                  This bridge&apos;s Chatwoot token belongs to {review.serviceToken.role ? `an ${review.serviceToken.role}` : "someone"} on account{" "}
                  {bridge.chatwootAccountId}. Only an administrator can add agents, so provisioning would fail.
                  {review.serviceToken.error ? ` (${review.serviceToken.error})` : ""}
                </p>
              )}
              {review.truncated && <p className="err">That channel has more members than this screen will read; only the first {review.candidates.length} are shown.</p>}
              <p className="note">
                {review.memberCount} in the channel · {review.candidates.filter((c) => c.bucket === "member").length} already agents ·{" "}
                {review.candidates.filter((c) => c.bucket === "existing").length} known to Chatwoot ·{" "}
                {review.candidates.filter((c) => c.bucket === "invite").length} would be new accounts ·{" "}
                {review.candidates.filter((c) => c.bucket === "blocked").length} cannot be provisioned
              </p>

              {(["existing", "invite", "member", "blocked"] as HelperBucket[]).map((bucket) => {
                const rows = review.candidates.filter((c) => c.bucket === bucket);
                if (rows.length === 0) return null;
                return (
                  <Bucket
                    key={bucket}
                    bucket={bucket}
                    rows={rows}
                    picked={picked}
                    disabled={(Boolean(noProvisioning) && noAsking) || busy !== null}
                    onToggle={(id, on) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                    onSkip={roster?.canProvision ? (id) => void run("skip", () => api.post(`/bridges/${bridge.id}/helpers/${id}/skip`)) : undefined}
                  />
                );
              })}

              <div className="row" style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <button
                  className="primary"
                  disabled={toAsk.length === 0 || overBatch || noAsking || busy !== null}
                  onClick={() => void act("ask", toAsk.map((c) => c.slackUserId))}
                >
                  {busy === "ask" ? "Sending…" : `Ask ${toAsk.length} to link`}
                </button>
                <button
                  disabled={toProvision.length === 0 || overBatch || Boolean(noProvisioning) || busy !== null}
                  onClick={() => void act("provision", toProvision.map((c) => c.slackUserId))}
                >
                  {busy === "provision" ? "Provisioning…" : `Provision ${toProvision.length} ${toProvision.length === 1 ? "person" : "people"}`}
                </button>
                <span className="note">
                  Asking sends {toAsk.length} direct {toAsk.length === 1 ? "message" : "messages"} and creates nothing. Provisioning adds{" "}
                  {toProvision.filter((c) => c.bucket === "existing").length} to the Chatwoot account.
                </span>
              </div>
              {overBatch && (
                <p className="err">
                  This bridge allows {review.maxBatch} people at a time. Do it in batches, or raise the limit in the bridge&apos;s settings if you really mean
                  it.
                </p>
              )}
              {!review.canProvision && <p className="note">Only this bridge&apos;s admins can provision people or send them a link request.</p>}
              {roster && review.canProvision && !roster.linkPrompt && (
                <p className="note">
                  This bridge has no link message set, so nobody can be asked. Add one under <strong>Edit</strong> → <em>Helpers</em>.
                </p>
              )}

              {review.departed.length > 0 && (
                <>
                  <h3 className="step">Left the channel</h3>
                  <table>
                    <tbody>
                      {review.departed.map((c) => (
                        <tr key={c.slackUserId}>
                          <td>
                            <strong>{c.name}</strong>
                            <div className="note mono">{c.slackUserId}</div>
                          </td>
                          <td className="note">{c.email ?? "no email"}</td>
                          <td>
                            <span className={`pill ${c.state === "provisioned" ? "warn" : "off"}`}>{c.state ?? "untracked"}</span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {c.state === "provisioned" && roster?.canProvision && (
                              <button
                                className="small danger"
                                disabled={busy !== null}
                                onClick={() => {
                                  if (!confirm(`Take ${c.name} off Chatwoot account ${bridge.chatwootAccountId}? Their Chatwoot user and its history are kept.`)) return;
                                  void run("unlink", async () => {
                                    await api.post(`/bridges/${bridge.id}/helpers/${c.slackUserId}/unlink`);
                                    setReview(await api.post<HelperReview>(`/bridges/${bridge.id}/helpers/review`));
                                  });
                                }}
                              >
                                Unlink
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}

          {results && (
            <>
              <h3 className="step">What just happened</h3>
              <table>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.slackUserId}>
                      <td className="mono">{r.slackUserId}</td>
                      <td>{r.ok ? <span className="pill ok">done</span> : <span className="pill warn">no</span>}</td>
                      <td className="note">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {roster && roster.members.length > 0 && (
            <>
              <h3 className="step">Tracked roster</h3>
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Chatwoot</th>
                    <th>State</th>
                    <th>In channel</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {roster.members.map((m) => (
                    <tr key={m.slackUserId}>
                      <td>
                        <strong>{m.name ?? m.slackUserId}</strong>
                        <div className="note mono">{m.slackUserId}</div>
                      </td>
                      <td className="note">
                        {m.chatwootUserId ? `user ${m.chatwootUserId}` : "—"}
                        {m.email && <div>{m.email}</div>}
                      </td>
                      <td>
                        <span className={`pill ${m.state === "provisioned" ? "ok" : m.state === "failed" ? "warn" : "off"}`}>{m.state}</span>
                        {m.lastError && <div className="note">{m.lastError}</div>}
                        {m.state === "pending" && m.linkAskedAt && <div className="note">asked to link {fmtDate(m.linkAskedAt)}</div>}
                      </td>
                      <td>{m.inChannel ? <span className="pill ok">yes</span> : <span className="pill off">no</span>}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {roster.canProvision && m.state === "provisioned" && (
                          <button
                            className="small danger"
                            disabled={busy !== null}
                            onClick={() => {
                              if (!confirm(`Take ${m.name ?? m.slackUserId} off Chatwoot account ${bridge.chatwootAccountId}? Their Chatwoot user is kept.`)) return;
                              void run("unlink", () => api.post(`/bridges/${bridge.id}/helpers/${m.slackUserId}/unlink`));
                            }}
                          >
                            Unlink
                          </button>
                        )}
                        {roster.canProvision && m.state === "skipped" && (
                          <button className="small" disabled={busy !== null} onClick={() => void run("unskip", () => api.del(`/bridges/${bridge.id}/helpers/${m.slackUserId}/skip`))}>
                            Un-skip
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {roster && roster.events.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary>Recent activity ({roster.events.length})</summary>
              <table>
                <tbody>
                  {roster.events.map((e) => (
                    <tr key={e.id}>
                      <td className="note" style={{ whiteSpace: "nowrap" }}>
                        {fmtDate(e.createdAt)}
                      </td>
                      <td>
                        <span className="pill">{e.action}</span>
                      </td>
                      <td className="mono">{e.slackUserId ?? ""}</td>
                      <td className="note">
                        {e.detail}
                        {e.actor ? ` — by ${e.actor}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Somebody we could ask to link: unconfirmed, a person, and not nagged in the last week. */
function askable(c: HelperCandidate): boolean {
  if (c.bucket !== "invite" && c.bucket !== "blocked") return false;
  if (c.bucket === "blocked" && c.reason.includes("bot")) return false;
  if (c.state === "provisioned" || c.state === "skipped") return false;
  return !c.linkAskedAt || Date.now() - new Date(c.linkAskedAt).getTime() > 7 * 24 * 60 * 60_000;
}

/** Is there anything at all to do for this person? Drives what is ticked after a review. */
function actionable(c: HelperCandidate): boolean {
  if (c.state === "provisioned" || c.state === "skipped") return false;
  return c.bucket === "existing" || askable(c);
}

const BUCKETS: Record<HelperBucket, { title: string; note: string }> = {
  existing: {
    title: "Chatwoot already knows them",
    note: "Adding them to this account creates no new login and sends no invitation. Ticked by default.",
  },
  invite: {
    title: "Chatwoot has never seen them",
    note: "Ask these people to link instead of guessing: their Chatwoot address is often not the one on their Slack profile, and inviting the wrong one gives them a second account. Provisioning them anyway is the second button, and only right if you know the address is correct.",
  },
  member: { title: "Already agents on this account", note: "Nothing happens in Chatwoot; ticking one just records that this bridge knows them." },
  blocked: { title: "Nothing to go on", note: "No email at all, or not a person. Anyone who is a person can still be asked to link — that is how we find out." },
};

function Bucket({
  bucket,
  rows,
  picked,
  disabled,
  onToggle,
  onSkip,
}: {
  bucket: HelperBucket;
  rows: HelperCandidate[];
  picked: Set<string>;
  disabled: boolean;
  onToggle: (slackUserId: string, on: boolean) => void;
  onSkip?: (slackUserId: string) => void;
}) {
  const meta = BUCKETS[bucket];
  const eligible = rows.filter(actionable);
  const allPicked = eligible.length > 0 && eligible.every((r) => picked.has(r.slackUserId));
  return (
    <>
      <h3 className="step">
        {meta.title} ({rows.length})
      </h3>
      <p className="note" style={{ marginTop: -4 }}>
        {meta.note}
        {eligible.length > 1 && (
          <>
            {" "}
            <button className="small" disabled={disabled} onClick={() => eligible.forEach((r) => onToggle(r.slackUserId, !allPicked))}>
              {allPicked ? "Untick all" : `Tick all ${eligible.length}`}
            </button>
          </>
        )}
      </p>
      <table>
        <tbody>
          {rows.map((c) => (
            <tr key={c.slackUserId}>
              <td style={{ width: 28 }}>
                {actionable(c) && (
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    disabled={disabled}
                    checked={picked.has(c.slackUserId)}
                    onChange={(e) => onToggle(c.slackUserId, e.target.checked)}
                  />
                )}
              </td>
              <td>
                <strong>{c.name}</strong>
                <div className="note mono">{c.slackUserId}</div>
              </td>
              <td>
                {c.email ?? <span className="muted">no email</span>}
                {c.emailSource === "slack" && c.email && <div className="note">their Slack profile address — nothing has confirmed Chatwoot knows it</div>}
                {c.emailSource === "hackclub" && <div className="note">verified by Hack Club Auth — the address they sign in with</div>}
                {c.emailSource === "admin" && <div className="note">set by hand in this panel</div>}
                {c.emailSource === "chatwoot" && <div className="note">confirmed: Chatwoot user {c.chatwootUserId}</div>}
              </td>
              <td className="note">{c.reason}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {c.state && <span className={`pill ${c.state === "provisioned" ? "ok" : c.state === "failed" ? "warn" : "off"}`}>{c.state}</span>}{" "}
                {c.linkAskedAt && <div className="note">asked to link {fmtDate(c.linkAskedAt)}</div>}
                {onSkip && c.state !== "provisioned" && c.state !== "skipped" && (
                  <button className="small" disabled={disabled} onClick={() => onSkip(c.slackUserId)}>
                    Skip
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
