"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentId,
  defaultNegotiationSession,
  emptyMemory,
  makeEvent,
  NegotiationAgentConfig,
  NegotiationSession,
} from "@/lib/agents";
import { DEFAULT_PAYOFF, Move, PayoffMatrix } from "@/lib/game";

const agentColor: Record<AgentId, string> = {
  A: "#60a5fa",
  B: "#fb7185",
};

export default function Page() {
  const [session, setSession] = useState<NegotiationSession>(() => defaultNegotiationSession());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    session.transcript.length < session.config.maxMessages &&
    !(session.finalDecisions.A && session.finalDecisions.B);
  const finishReason = session.payoff
    ? `Finished because both agents finalized. Outcome ${session.payoff.outcome}, payoff ${session.payoff.a}/${session.payoff.b}.`
    : session.status === "finished"
      ? "Finished because the message cap was reached before both agents finalized."
      : null;

  async function requestStep(input: NegotiationSession) {
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: ensureStarted(input) }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Negotiation step failed.");
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
          current.transcript.length >= current.config.maxMessages ||
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
      return {
        ...current,
        config: {
          ...current.config,
          actualPayoff: {
            ...current.config.actualPayoff,
            [key]: nextCell,
          },
        },
      };
    });
  }

  function updateAgentPayoff(agent: AgentId, key: keyof PayoffMatrix, index: 0 | 1, value: number) {
    setSession((current) => {
      const cell = current.agents[agent].perceivedPayoff[key];
      const nextCell: [number, number] = index === 0 ? [value, cell[1]] : [cell[0], value];

      return {
        ...current,
        agents: {
          ...current.agents,
          [agent]: {
            ...current.agents[agent],
            perceivedPayoff: {
              ...current.agents[agent].perceivedPayoff,
              [key]: nextCell,
            },
          },
        },
      };
    });
  }

  return (
    <main className="shell">
      <section className="topbar">
        <h1>LLM Negotiation Lab</h1>
        <div className="controls">
          <button className="primary" onClick={autoRun} disabled={!canStep}>
            {running ? "Running..." : "Auto-run"}
          </button>
          <button onClick={stepOnce} disabled={!canStep}>
            Step one turn
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
        <aside className="side">
          <AgentPanel
            agent={session.agents.A}
            updateAgent={(patch) => updateAgent("A", patch)}
            updatePayoff={(key, index, value) => updateAgentPayoff("A", key, index, value)}
            disabled={running || session.transcript.length > 0}
          />
        </aside>

        <section className="center">
          <div className="status-grid">
            <Metric label="Status" value={session.status} />
            <Metric label="Next speaker" value={session.agents[session.nextSpeaker].name} />
            <Metric label="Messages" value={`${session.transcript.length} / ${session.config.maxMessages}`} />
            <Metric label="Finals" value={`${session.finalDecisions.A ? "A" : "-"} ${session.finalDecisions.B ? "B" : "-"}`} />
            <Metric label="Tokens" value={String(totals.total)} />
            <Metric
              label="Outcome"
              value={session.payoff ? `${session.payoff.outcome} (${session.payoff.a}/${session.payoff.b})` : "pending"}
            />
          </div>

          <details className="config-panel">
            <summary>
              <span>Experiment setup</span>
              <span className="muted">
                min {session.config.minMessagesBeforeFinal}, max {session.config.maxMessages}, decision {session.config.finalDecisionWindow}
              </span>
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
                        config: {
                          ...current.config,
                          minMessagesBeforeFinal: parseInt(event.target.value || "0", 10),
                        },
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
                          maxMessages: Math.max(
                            current.config.minMessagesBeforeFinal,
                            parseInt(event.target.value || "2", 10)
                          ),
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
                        config: {
                          ...current.config,
                          finalDecisionWindow: parseInt(event.target.value || "1", 10),
                        },
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
                        config: {
                          ...current.config,
                          maxAutoSteps: parseInt(event.target.value || "1", 10),
                        },
                      }))
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    setSession((current) => ({
                      ...current,
                      config: { ...current.config, actualPayoff: DEFAULT_PAYOFF },
                    }))
                  }
                  disabled={running}
                >
                  Reset payoff
                </button>
              </div>
              <label>
                Public experiment context
                <textarea
                  rows={2}
                  value={session.config.publicContext}
                  disabled={running || session.transcript.length > 0}
                  onChange={(event) =>
                    setSession((current) => ({
                      ...current,
                      config: { ...current.config, publicContext: event.target.value },
                    }))
                  }
                />
              </label>
              <div className="payoff-section">
                <div>
                  <h3>Actual payoff</h3>
                  <p className="muted">Environment truth used for scoring.</p>
                </div>
                <PayoffEditor payoff={session.config.actualPayoff} updatePayoff={updateActualPayoff} disabled={running} />
              </div>
            </div>
          </details>

          <Conversation session={session} running={running} />
        </section>

        <aside className="side">
          <AgentPanel
            agent={session.agents.B}
            updateAgent={(patch) => updateAgent("B", patch)}
            updatePayoff={(key, index, value) => updateAgentPayoff("B", key, index, value)}
            disabled={running || session.transcript.length > 0}
          />
        </aside>
      </section>
    </main>
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

function AgentPanel({
  agent,
  updateAgent,
  updatePayoff,
  disabled,
}: {
  agent: NegotiationAgentConfig;
  updateAgent: (patch: Partial<NegotiationAgentConfig>) => void;
  updatePayoff: (key: keyof PayoffMatrix, index: 0 | 1, value: number) => void;
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
          <input value={agent.model} onChange={(event) => updateAgent({ model: event.target.value })} />
        </label>
        <label>
          Temperature: {agent.temperature.toFixed(2)}
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={agent.temperature}
            onChange={(event) => updateAgent({ temperature: parseFloat(event.target.value) })}
          />
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

      <div className="panel-section payoff-section">
        <div>
          <h3>Private Payoff Belief</h3>
          <p className="muted">This is the matrix Agent {agent.id} sees and reasons from.</p>
        </div>
        <PayoffEditor payoff={agent.perceivedPayoff} updatePayoff={updatePayoff} disabled={disabled} compact />
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
            Start the run to let Agent A open the negotiation. Messages can continue until the cap or until both agents finalize.
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
          onChange={(event) => updatePayoff(key, 0, parseInt(event.target.value || "0", 10))}
        />
        <input
          type="number"
          value={payoff[key][1]}
          disabled={disabled}
          onChange={(event) => updatePayoff(key, 1, parseInt(event.target.value || "0", 10))}
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
