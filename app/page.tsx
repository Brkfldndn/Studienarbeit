"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentId,
  defaultNegotiationSession,
  emptyMemory,
  ExperimentConditionId,
  makeEvent,
  NegotiationAgentConfig,
  NegotiationSession,
  OPENAI_MODEL_OPTIONS,
  PayoffObservability,
} from "@/lib/agents";
import {
  CANONICAL_PD_PAYOFF,
  Move,
  payoffDiagnostics,
  PayoffMatrix,
} from "@/lib/game";

const agentColor: Record<AgentId, string> = {
  A: "#60a5fa",
  B: "#fb7185",
};

const CORE_CONDITIONS: Array<{
  id: ExperimentConditionId;
  label: string;
  communication: boolean;
  payoffObservability: PayoffObservability;
}> = [
  {
    id: "public_no_communication",
    label: "Public / silent",
    communication: false,
    payoffObservability: "public",
  },
  {
    id: "public_communication",
    label: "Public / chat",
    communication: true,
    payoffObservability: "public",
  },
  {
    id: "private_no_communication",
    label: "Private / silent",
    communication: false,
    payoffObservability: "private",
  },
  {
    id: "private_communication",
    label: "Private / chat",
    communication: true,
    payoffObservability: "private",
  },
];

interface ExperimentManifestView {
  id: string;
  name: string;
  mode: "independent" | "sequence";
  createdAt: string;
  completedAt?: string;
  status: "running" | "completed" | "error";
  sequences: number;
  episodesPerSequence: number;
  persistMemory: boolean;
  summary?: {
    episodes: number;
    outcomes: Record<string, number>;
    cooperationA: number;
    cooperationB: number;
    averagePayoffA: number;
    averagePayoffB: number;
    averageWelfare: number;
    totalTokens: number;
  };
  error?: string;
}

async function readJsonResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`${fallbackMessage} Empty response from ${res.url || "server"} (${res.status}).`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${fallbackMessage} Server returned non-JSON response (${res.status}).`);
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `${fallbackMessage} HTTP ${res.status}.`);
  }

  return data as T;
}

export default function Page() {
  const [session, setSession] = useState<NegotiationSession>(() => defaultNegotiationSession());
  const [running, setRunning] = useState(false);
  const [experimentRunning, setExperimentRunning] = useState(false);
  const [experimentName, setExperimentName] = useState("pilot-sequence");
  const [experimentMode, setExperimentMode] = useState<"independent" | "sequence">("sequence");
  const [sequenceCount, setSequenceCount] = useState(5);
  const [episodesPerSequence, setEpisodesPerSequence] = useState(10);
  const [persistMemory, setPersistMemory] = useState(true);
  const [experiments, setExperiments] = useState<ExperimentManifestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [payoffObservability, setPayoffObservability] = useState<PayoffObservability>("public");
  const [fullExperimentProgress, setFullExperimentProgress] = useState<string | null>(null);
  const [isHostedDeployment, setIsHostedDeployment] = useState(false);

  useEffect(() => {
    void refreshExperiments();
    setIsHostedDeployment(
      window.location.hostname.endsWith(".vercel.app") ||
        (!["localhost", "127.0.0.1"].includes(window.location.hostname) && !window.location.hostname.endsWith(".local"))
    );
  }, []);

  const totals = useMemo(() => {
    return session.events.reduce(
      (acc, event) => ({
        prompt: acc.prompt + (event.tokens?.prompt || 0),
        completion: acc.completion + (event.tokens?.completion || 0),
        total: acc.total + (event.tokens?.total || 0),
      }),
      { prompt: 0, completion: 0, total: 0 }
    );
  }, [session.events]);

  const canStep =
    !running &&
    session.status !== "finished" &&
    (session.config.communication === false || session.transcript.length < session.config.maxMessages) &&
    !(session.finalDecisions.A && session.finalDecisions.B);
  const finishReason = session.payoff
    ? `Finished because both agents finalized. Outcome ${session.payoff.outcome}, payoff ${session.payoff.a}/${session.payoff.b}, welfare ${session.payoff.welfare}.`
    : session.status === "finished"
      ? "Finished because the message cap was reached before both agents finalized."
      : null;
  const proposedUtilityMatrix = CANONICAL_PD_PAYOFF;
  const utilityDiagnostics = useMemo(() => payoffDiagnostics(proposedUtilityMatrix), [proposedUtilityMatrix]);
  const plannedEpisodes = experimentMode === "sequence" ? sequenceCount * episodesPerSequence : sequenceCount;
  const plannedFullEpisodes = plannedEpisodes * CORE_CONDITIONS.length;

  async function requestStep(input: NegotiationSession) {
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: ensureStarted(input) }),
    });
    const data = await readJsonResponse<{ ok: true; session: NegotiationSession }>(res, "Negotiation step failed.");
    return data.session as NegotiationSession;
  }

  async function stepOnce() {
    if (!canStep) return;
    setRunning(true);
    setError(null);
    try {
      const next = await requestStep(session);
      setSession(next);
    } catch (err: any) {
      setError(err?.message ?? "Negotiation step failed.");
      setSession((current) => ({ ...current, status: "error" }));
    } finally {
      setRunning(false);
    }
  }

  async function autoRun() {
    if (!canStep) return;
    setRunning(true);
    setError(null);
    try {
      let current = session;
      for (let i = 0; i < session.config.maxAutoSteps; i++) {
        if (
          current.status === "finished" ||
          (current.config.communication !== false && current.transcript.length >= current.config.maxMessages) ||
          (current.finalDecisions.A && current.finalDecisions.B)
        ) {
          break;
        }

        current = await requestStep(current);
        setSession(current);
      }
    } catch (err: any) {
      setError(err?.message ?? "Auto-run failed.");
      setSession((current) => ({ ...current, status: "error" }));
    } finally {
      setRunning(false);
    }
  }

  async function refreshExperiments() {
    try {
      const res = await fetch("/api/experiments");
      const data = await readJsonResponse<{ ok: true; experiments: ExperimentManifestView[] }>(
        res,
        "Could not load experiments."
      );
      setExperiments(data.experiments || []);
    } catch (err: any) {
      setError(err?.message ?? "Could not load experiments.");
    }
  }

  async function runExperiment(baseSession = session, name = experimentName) {
    setExperimentRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          mode: experimentMode,
          sequences: sequenceCount,
          episodesPerSequence,
          persistMemory,
          baseSession,
        }),
      });
      await readJsonResponse<{ ok: true }>(res, "Experiment failed.");
      await refreshExperiments();
    } catch (err: any) {
      setError(err?.message ?? "Experiment failed.");
    } finally {
      setExperimentRunning(false);
    }
  }

  async function startFullExperiment() {
    if (isHostedDeployment) {
      setError("Full experiments should be run locally or in a background worker, not inside one Vercel request.");
      return;
    }

    setExperimentRunning(true);
    setError(null);
    try {
      for (let index = 0; index < CORE_CONDITIONS.length; index += 1) {
        const condition = CORE_CONDITIONS[index];
        setFullExperimentProgress(
          `Running ${condition.label} (${index + 1}/${CORE_CONDITIONS.length}) · ${plannedEpisodes} negotiations`
        );
        const configured = withCondition(session, condition.id);
        const res = await fetch("/api/experiments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${experimentName}-${condition.id}`,
            mode: experimentMode,
            sequences: sequenceCount,
            episodesPerSequence,
            persistMemory,
            baseSession: configured,
          }),
        });
        await readJsonResponse<{ ok: true }>(res, `Experiment failed for ${condition.label}.`);
        await refreshExperiments();
      }
      setFullExperimentProgress(`Completed ${plannedFullEpisodes} negotiations across four conditions.`);
    } catch (err: any) {
      setError(err?.message ?? "Full experiment failed.");
    } finally {
      setExperimentRunning(false);
    }
  }

  function resetSession(keepConfig = true) {
    const fresh = defaultNegotiationSession();
    if (keepConfig) {
      fresh.config = session.config;
      fresh.agents.A = { ...session.agents.A, memory: emptyMemory() };
      fresh.agents.B = { ...session.agents.B, memory: emptyMemory() };
    }
    setSession(fresh);
    setError(null);
  }

  function updateAgent(id: AgentId, patch: Partial<NegotiationAgentConfig>) {
    setSession((current) => ({
      ...current,
      agents: {
        ...current.agents,
        [id]: {
          ...current.agents[id],
          ...patch,
        },
      },
    }));
  }

  function updateActualPayoff(key: keyof PayoffMatrix, index: 0 | 1, value: number) {
    setSession((current) => {
      const cell = current.config.actualPayoff[key];
      const nextCell: [number, number] = index === 0 ? [value, cell[1]] : [cell[0], value];
      const nextPayoff = {
        ...current.config.actualPayoff,
        [key]: nextCell,
      };
      return {
        ...current,
        config: {
          ...current.config,
          actualPayoff: nextPayoff,
        },
        agents: {
          A: {
            ...current.agents.A,
            perceivedPayoff: nextPayoff,
          },
          B: {
            ...current.agents.B,
            perceivedPayoff: nextPayoff,
          },
        },
      };
    });
  }

  function applyCondition(communication = session.config.communication, observability = payoffObservability) {
    const conditionId = conditionIdFor(communication, observability);
    setSession((current) => ({
      ...current,
      config: {
        ...current.config,
        conditionId,
        communication,
        payoffObservability: observability,
        revealOpponentPayoffAfterEpisode: observability === "public",
        revealOpponentMatrix: observability === "public",
        actualPayoff: CANONICAL_PD_PAYOFF,
      },
      agents: {
        A: {
          ...current.agents.A,
          perceivedPayoff: CANONICAL_PD_PAYOFF,
        },
        B: {
          ...current.agents.B,
          perceivedPayoff: CANONICAL_PD_PAYOFF,
        },
      },
    }));
  }

  function applyPreset(conditionId: ExperimentConditionId) {
    const condition = CORE_CONDITIONS.find((item) => item.id === conditionId);
    if (!condition) return;
    setPayoffObservability(condition.payoffObservability);
    applyCondition(condition.communication, condition.payoffObservability);
  }

  return (
    <main className="shell">
      <section className="topbar">
        <h1>LLM Negotiation Lab</h1>
        <div className="controls">
          <button className="primary" onClick={autoRun} disabled={!canStep}>
            {running ? "Running negotiation..." : "Run one negotiation"}
          </button>
          <button onClick={stepOnce} disabled={!canStep}>
            Step one agent
          </button>
          <button onClick={() => resetSession(true)} disabled={running}>
            Reset run
          </button>
          <button onClick={() => resetSession(false)} disabled={running}>
            Defaults
          </button>
        </div>
      </section>

      {error && <div className="error">Error: {error}</div>}
      {finishReason && <div className="toast">{finishReason} Use Reset run to start another negotiation.</div>}

      <section className="workspace">
        <aside className="setup-rail">
          <div className="status-grid">
            <Metric label="Status" value={session.status} />
            <Metric label="Next" value={`Agent ${session.nextSpeaker}`} />
            <Metric label="Messages" value={session.config.communication ? `${session.transcript.length}/${session.config.maxMessages}` : "off"} />
            <Metric label="Finals" value={`${session.finalDecisions.A ? "A" : "-"} ${session.finalDecisions.B ? "B" : "-"}`} />
            <Metric label="Tokens" value={String(totals.total)} />
            <Metric
              label="Outcome"
              value={
                session.payoff
                  ? `${session.payoff.outcome} (${session.payoff.a}/${session.payoff.b}, W ${session.payoff.welfare})`
                  : "pending"
              }
            />
          </div>

          <section className="treatment-card">
            <div className="section-heading">
              <span>Payoff Observability</span>
              <strong>{session.config.payoffObservability === "public" ? "Public payoff matrix" : "Private payoff tables"}</strong>
            </div>
            <div className="segmented two">
              <button
                className={session.config.payoffObservability === "public" ? "selected" : ""}
                onClick={() => {
                  setPayoffObservability("public");
                  applyCondition(session.config.communication, "public");
                }}
                disabled={running || session.transcript.length > 0}
              >
                Public
              </button>
              <button
                className={session.config.payoffObservability === "private" ? "selected" : ""}
                onClick={() => {
                  setPayoffObservability("private");
                  applyCondition(session.config.communication, "private");
                }}
                disabled={running || session.transcript.length > 0}
              >
                Private
              </button>
            </div>
            <PayoffEditor payoff={proposedUtilityMatrix} updatePayoff={() => undefined} disabled compact />
            <div className="diagnostics">
              <span className={utilityDiagnostics.cooperationMaximizesWelfare ? "chip good" : "chip bad"}>
                welfare: CC {utilityDiagnostics.welfare.CC}
              </span>
              <span className="chip">
                exploit {utilityDiagnostics.welfare.CD}/{utilityDiagnostics.welfare.DC}
              </span>
            </div>
          </section>

          <section className="treatment-card compact-card">
            <div className="section-heading">
              <span>Communication</span>
              <strong>{session.config.communication ? "Free-text chat" : "No communication"}</strong>
            </div>
            <div className="segmented two">
              <button
                className={session.config.communication ? "selected" : ""}
                disabled={running || session.transcript.length > 0}
                onClick={() =>
                  applyCondition(true, session.config.payoffObservability)
                }
              >
                Chat
              </button>
              <button
                className={!session.config.communication ? "selected" : ""}
                disabled={running || session.transcript.length > 0}
                onClick={() =>
                  applyCondition(false, session.config.payoffObservability)
                }
              >
                Silent
              </button>
            </div>
          </section>

          <details className="config-panel">
            <summary>
              <span>Run settings</span>
              <span className="muted">max {session.config.maxMessages}, decision {session.config.finalDecisionWindow}</span>
            </summary>
            <div className="config-content">
              <div className="config-row">
                <label>
                  Min messages
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={session.config.minMessagesBeforeFinal}
                    disabled={running || session.transcript.length > 0}
                    onChange={(event) =>
                      setSession((current) => ({
                        ...current,
                        config: { ...current.config, minMessagesBeforeFinal: parseInt(event.target.value || "0", 10) },
                      }))
                    }
                  />
                </label>
                <label>
                  Max messages
                  <input
                    type="number"
                    min={Math.max(2, session.config.minMessagesBeforeFinal)}
                    max={100}
                    value={session.config.maxMessages}
                    disabled={running || session.transcript.length > 0}
                    onChange={(event) =>
                      setSession((current) => ({
                        ...current,
                        config: {
                          ...current.config,
                          maxMessages: Math.max(current.config.minMessagesBeforeFinal, parseInt(event.target.value || "2", 10)),
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  Decision window
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={session.config.finalDecisionWindow}
                    disabled={running || session.transcript.length > 0}
                    onChange={(event) =>
                      setSession((current) => ({
                        ...current,
                        config: { ...current.config, finalDecisionWindow: parseInt(event.target.value || "1", 10) },
                      }))
                    }
                  />
                </label>
                <label>
                  Auto steps
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={session.config.maxAutoSteps}
                    disabled={running}
                    onChange={(event) =>
                      setSession((current) => ({
                        ...current,
                        config: { ...current.config, maxAutoSteps: parseInt(event.target.value || "1", 10) },
                      }))
                    }
                  />
                </label>
              </div>
              <details className="advanced-matrix">
                <summary>Manual matrix override</summary>
                <PayoffEditor payoff={session.config.actualPayoff} updatePayoff={updateActualPayoff} disabled={running} />
              </details>
            </div>
          </details>

          <details className="config-panel">
            <summary>
              <span>Batch experiments</span>
              <span className="muted">
                {isHostedDeployment
                  ? "local/background worker required"
                  : experimentMode === "sequence"
                    ? `${plannedEpisodes} negotiations`
                    : `${plannedEpisodes} negotiations`}
              </span>
            </summary>
            <div className="config-content">
              {isHostedDeployment && (
                <p className="warning-text">
                  Batch experiments run many model calls and will time out on Vercel. Use Run one negotiation here; run saved
                  batches locally or move them to a background job/database worker.
                </p>
              )}
              <p className="muted">
                This batch will run {plannedEpisodes} complete negotiations
                {experimentMode === "sequence" ? ` (${sequenceCount} sequences x ${episodesPerSequence} episodes)` : ""}.
              </p>
              <div className="config-row">
                <label className="wide-label">
                  Name
                  <input value={experimentName} onChange={(event) => setExperimentName(event.target.value)} />
                </label>
                <label>
                  Mode
                  <select
                    value={experimentMode}
                    onChange={(event) => setExperimentMode(event.target.value as "independent" | "sequence")}
                  >
                    <option value="sequence">Sequences</option>
                    <option value="independent">Independent runs</option>
                  </select>
                </label>
                <label>
                  {experimentMode === "sequence" ? "Sequences" : "Runs"}
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={sequenceCount}
                    onChange={(event) => setSequenceCount(parseInt(event.target.value || "1", 10))}
                  />
                </label>
                <label>
                  Episodes / sequence
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={episodesPerSequence}
                    disabled={experimentMode === "independent"}
                    onChange={(event) => setEpisodesPerSequence(parseInt(event.target.value || "1", 10))}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={persistMemory}
                    disabled={experimentMode === "independent"}
                    onChange={(event) => setPersistMemory(event.target.checked)}
                  />
                  Carry memory
                </label>
                <button onClick={() => runExperiment()} disabled={running || experimentRunning || isHostedDeployment}>
                  {experimentRunning ? "Running..." : "Run selected condition"}
                </button>
                <button className="primary" onClick={startFullExperiment} disabled={running || experimentRunning || isHostedDeployment}>
                  Start full 2x2 experiment
                </button>
                <button onClick={refreshExperiments} disabled={experimentRunning}>
                  Refresh
                </button>
              </div>
              {fullExperimentProgress && <p className="progress-text">{fullExperimentProgress}</p>}
              <ExperimentList experiments={experiments} />
            </div>
          </details>

          <details className="config-panel">
            <summary>
              <span>Agent setup</span>
              <span className="muted">{session.agents.A.model} / {session.agents.B.model}</span>
            </summary>
            <div className="agent-pair">
              <AgentPanel
                agent={session.agents.A}
                updateAgent={(patch) => updateAgent("A", patch)}
                disabled={running || session.transcript.length > 0}
              />
              <AgentPanel
                agent={session.agents.B}
                updateAgent={(patch) => updateAgent("B", patch)}
                disabled={running || session.transcript.length > 0}
              />
            </div>
          </details>
        </aside>

        <section className="center">
          <Conversation session={session} running={running} />
        </section>
      </section>
    </main>
  );
}

function ExperimentList({ experiments }: { experiments: ExperimentManifestView[] }) {
  if (!experiments.length) {
    return <p className="muted">No saved experiments yet. Runs will appear here after they finish.</p>;
  }

  return (
    <div className="experiment-list">
      {experiments.slice(0, 6).map((experiment) => {
        const summary = experiment.summary;
        return (
          <article className="experiment-item" key={experiment.id}>
            <div>
              <strong>{experiment.name}</strong>
              <p className="muted">
                {experiment.status} · {experiment.mode} · {summary?.episodes ?? experiment.sequences} episodes
                {summary
                  ? ` · CC ${summary.outcomes.CC || 0}, CD ${summary.outcomes.CD || 0}, DC ${summary.outcomes.DC || 0}, DD ${summary.outcomes.DD || 0}`
                  : ""}
              </p>
              {summary && (
                <p className="muted">
                  coop A {(summary.cooperationA * 100).toFixed(0)}%, coop B {(summary.cooperationB * 100).toFixed(0)}% · avg payoff{" "}
                  {summary.averagePayoffA.toFixed(2)}/{summary.averagePayoffB.toFixed(2)} · welfare{" "}
                  {summary.averageWelfare?.toFixed(2) ?? "n/a"}
                </p>
              )}
              {experiment.error && <p className="error-text">{experiment.error}</p>}
            </div>
            <div className="experiment-links">
              <a href={`/api/experiments/${experiment.id}/file?file=summary.csv`}>summary</a>
              <a href={`/api/experiments/${experiment.id}/file?file=episodes.jsonl`}>episodes</a>
              <a href={`/api/experiments/${experiment.id}/file?file=messages.jsonl`}>messages</a>
              <a href={`/api/experiments/${experiment.id}/file?file=model_calls.jsonl`}>calls</a>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ensureStarted(session: NegotiationSession): NegotiationSession {
  if (session.events.some((event) => event.type === "session_started")) {
    return { ...session, status: "running" };
  }

  return {
    ...session,
    status: "running",
    events: [
      makeEvent({
        turn: 0,
        type: "session_started",
        content: "Negotiation session started.",
      }),
      ...session.events,
    ],
  };
}

function conditionIdFor(communication: boolean, payoffObservability: PayoffObservability): ExperimentConditionId {
  if (payoffObservability === "public") {
    return communication ? "public_communication" : "public_no_communication";
  }

  return communication ? "private_communication" : "private_no_communication";
}

function withCondition(session: NegotiationSession, conditionId: ExperimentConditionId): NegotiationSession {
  const condition = CORE_CONDITIONS.find((item) => item.id === conditionId);
  if (!condition) return session;

  return {
    ...session,
    config: {
      ...session.config,
      conditionId,
      communication: condition.communication,
      payoffObservability: condition.payoffObservability,
      revealOpponentPayoffAfterEpisode: condition.payoffObservability === "public",
      revealOpponentMatrix: condition.payoffObservability === "public",
      actualPayoff: CANONICAL_PD_PAYOFF,
    },
    agents: {
      A: {
        ...session.agents.A,
        perceivedPayoff: CANONICAL_PD_PAYOFF,
        memory: emptyMemory(),
      },
      B: {
        ...session.agents.B,
        perceivedPayoff: CANONICAL_PD_PAYOFF,
        memory: emptyMemory(),
      },
    },
    transcript: [],
    events: [],
    finalDecisions: {},
    payoff: undefined,
    nextSpeaker: Math.random() < 0.5 ? "A" : "B",
    status: "idle",
  };
}

function AgentPanel({
  agent,
  updateAgent,
  disabled,
}: {
  agent: NegotiationAgentConfig;
  updateAgent: (patch: Partial<NegotiationAgentConfig>) => void;
  disabled: boolean;
}) {
  return (
    <div className="agent-stack">
      <div className="agent-card" style={{ borderColor: agentColor[agent.id] }}>
        <div className="row-between">
          <div>
            <p className="muted">Agent {agent.id}</p>
            <h2 style={{ color: agentColor[agent.id] }}>{agent.name}</h2>
          </div>
          <div className="avatar" style={{ background: agentColor[agent.id] }}>
            {agent.id}
          </div>
        </div>
        <label>
          Name
          <input value={agent.name} onChange={(event) => updateAgent({ name: event.target.value })} />
        </label>
        <label>
          Model
          <select value={agent.model} onChange={(event) => updateAgent({ model: event.target.value })}>
            {OPENAI_MODEL_OPTIONS.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel-section">
        <h3>System Prompt</h3>
        <textarea
          rows={7}
          value={agent.systemPrompt}
          onChange={(event) => updateAgent({ systemPrompt: event.target.value })}
        />
      </div>

      <div className="panel-section memory">
        <h3>Private Memory</h3>
        <p>{agent.memory.summary}</p>
        <MemoryList title="Commitments" items={agent.memory.commitments} />
        <MemoryList title="Observations" items={agent.memory.observations} />
        <MemoryList title="Strategy notes" items={agent.memory.strategyNotes} />
      </div>
    </div>
  );
}

function MemoryList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="memory-list">
      <strong>{title}</strong>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">None yet.</p>
      )}
    </div>
  );
}

function Conversation({ session, running }: { session: NegotiationSession; running: boolean }) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [session.transcript.length, session.finalDecisions.A, session.finalDecisions.B]);

  return (
    <div className="conversation">
      <div className="row-between">
        <h2>Live Negotiation</h2>
        {running && <span className="pulse">agent thinking</span>}
      </div>
      <div className="transcript" ref={transcriptRef}>
        {session.transcript.map((message) => (
          <article className={`bubble ${message.from === "A" ? "left" : "right"}`} key={message.id}>
            <div className="bubble-meta">
              <strong style={{ color: agentColor[message.from] }}>{session.agents[message.from].name}</strong>
              <span>turn {message.turn}</span>
            </div>
            <p>{message.content}</p>
          </article>
        ))}

        {session.transcript.length === 0 && (
          <div className="empty">
            {session.finalDecisions.A || session.finalDecisions.B
              ? "Both agents finalized without sending public messages."
              : `Start the run to let Agent ${session.nextSpeaker} open the negotiation. Messages can continue until the cap or until both agents finalize.`}
          </div>
        )}
      </div>

      <div className="finals">
        <FinalDecisionView agent="A" session={session} />
        <FinalDecisionView agent="B" session={session} />
      </div>
    </div>
  );
}

function FinalDecisionView({ agent, session }: { agent: AgentId; session: NegotiationSession }) {
  const decision = session.finalDecisions[agent];
  return (
    <div className="final-card" style={{ borderColor: agentColor[agent] }}>
      <strong>{session.agents[agent].name} final</strong>
      {decision ? (
        <>
          <span className={`badge ${decision.move === "C" ? "coop" : "def"}`}>
            {decision.move === "C" ? "Cooperate" : "Defect"}
          </span>
          <p>{decision.rationale}</p>
        </>
      ) : (
        <p className="muted">Not submitted.</p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PayoffEditor({
  payoff,
  updatePayoff,
  disabled,
  compact = false,
}: {
  payoff: PayoffMatrix;
  updatePayoff: (key: keyof PayoffMatrix, index: 0 | 1, value: number) => void;
  disabled: boolean;
  compact?: boolean;
}) {
  const cell = (key: keyof PayoffMatrix, label: string, moves: [Move, Move]) => (
    <div className="payoff-cell">
      <span>
        {label} ({moves[0]}/{moves[1]})
      </span>
      <div className="row">
        <input
          type="number"
          value={payoff[key][0]}
          disabled={disabled}
          step="0.5"
          onChange={(event) => updatePayoff(key, 0, parseFloat(event.target.value || "0"))}
        />
        <input
          type="number"
          value={payoff[key][1]}
          disabled={disabled}
          step="0.5"
          onChange={(event) => updatePayoff(key, 1, parseFloat(event.target.value || "0"))}
        />
      </div>
    </div>
  );

  return (
    <div className={compact ? "payoff-grid compact" : "payoff-grid"}>
      {cell("CC", "Both cooperate", ["C", "C"])}
      {cell("CD", "A coop, B defect", ["C", "D"])}
      {cell("DC", "A defect, B coop", ["D", "C"])}
      {cell("DD", "Both defect", ["D", "D"])}
    </div>
  );
}
