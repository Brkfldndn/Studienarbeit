"use client";

import { useMemo, useState } from "react";
import {
  AgentConfig,
  DEFAULT_PAYOFF,
  GameConfig,
  PayoffMatrix,
  RoundResult,
} from "@/lib/game";

const defaultAgentA: AgentConfig = {
  name: "Alice",
  role: "You are Alice, a thoughtful player who values long-term outcomes.",
  temperature: 0.7,
  model: "gpt-4o-mini",
};
const defaultAgentB: AgentConfig = {
  name: "Bob",
  role: "You are Bob, a pragmatic player focused on maximizing your own score.",
  temperature: 0.7,
  model: "gpt-4o-mini",
};

export default function Page() {
  const [rounds, setRounds] = useState(10);
  const [communication, setCommunication] = useState(false);
  const [payoff, setPayoff] = useState<PayoffMatrix>(DEFAULT_PAYOFF);
  const [agentA, setAgentA] = useState<AgentConfig>(defaultAgentA);
  const [agentB, setAgentB] = useState<AgentConfig>(defaultAgentB);

  const [history, setHistory] = useState<RoundResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentThinkingA, setCurrentThinkingA] = useState<string>("");
  const [currentThinkingB, setCurrentThinkingB] = useState<string>("");

  const totals = useMemo(() => {
    return history.reduce(
      (acc, r) => ({ a: acc.a + r.payoffA, b: acc.b + r.payoffB }),
      { a: 0, b: 0 }
    );
  }, [history]);

  const config: GameConfig = { rounds, payoff, communication, agentA, agentB };

  async function playRound(currentHistory: RoundResult[], lastMsgs: { fromA?: string; fromB?: string }) {
    const res = await fetch("/api/round", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config, history: currentHistory, lastMessages: lastMsgs }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "round failed");
    return data.result as RoundResult;
  }

  async function runGame() {
    setRunning(true);
    setError(null);
    setHistory([]);
    setCurrentThinkingA("");
    setCurrentThinkingB("");
    try {
      let h: RoundResult[] = [];
      let lastA: string | undefined;
      let lastB: string | undefined;
      for (let i = 0; i < rounds; i++) {
        setCurrentThinkingA(`Thinking about round ${i + 1}…`);
        setCurrentThinkingB(`Thinking about round ${i + 1}…`);
        const r = await playRound(h, { fromA: lastA, fromB: lastB });
        h = [...h, r];
        lastA = r.messageA;
        lastB = r.messageB;
        setHistory(h);
        setCurrentThinkingA(r.reasoningA);
        setCurrentThinkingB(r.reasoningB);
      }
    } catch (e: any) {
      setError(e?.message ?? "error");
    } finally {
      setRunning(false);
    }
  }

  function resetGame() {
    setHistory([]);
    setCurrentThinkingA("");
    setCurrentThinkingB("");
    setError(null);
  }

  const leader =
    totals.a === totals.b ? "Tied" : totals.a > totals.b ? `${agentA.name} leads` : `${agentB.name} leads`;

  const coopRateA = history.length
    ? (history.filter((r) => r.moveA === "C").length / history.length) * 100
    : 0;
  const coopRateB = history.length
    ? (history.filter((r) => r.moveB === "C").length / history.length) * 100
    : 0;

  return (
    <main style={{ display: "flex", width: "100vw", height: "100vh" }}>
      {/* LEFT — Agent A 20vw */}
      <section
        style={{
          width: "20vw",
          height: "100vh",
          borderRight: "1px solid #1d2740",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          overflowY: "auto",
        }}
      >
        <AgentPanel
          title={agentA.name}
          color="#4ade80"
          agent={agentA}
          setAgent={setAgentA}
          thinking={currentThinkingA}
          lastMove={history.at(-1)?.moveA}
          lastMessage={history.at(-1)?.messageA}
          score={totals.a}
          coopRate={coopRateA}
        />
      </section>

      {/* MIDDLE — game status 50vw */}
      <section
        style={{
          width: "50vw",
          height: "100vh",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflowY: "auto",
        }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ fontSize: 20 }}>Prisoner&apos;s Dilemma — LLM Replication</h1>
          <div className="muted">Flood (1958)</div>
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <Score name={agentA.name} score={totals.a} color="#4ade80" />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{leader}</div>
              <div className="muted">
                Round {history.length} / {rounds}
              </div>
            </div>
            <Score name={agentB.name} score={totals.b} color="#f87171" />
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 4 }}>
              Rounds
              <input
                type="number"
                min={1}
                max={50}
                value={rounds}
                disabled={running}
                onChange={(e) => setRounds(parseInt(e.target.value || "1"))}
                style={{ width: 60 }}
              />
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={communication}
                disabled={running}
                onChange={(e) => setCommunication(e.target.checked)}
              />
              Communication
            </label>
            <button
              onClick={runGame}
              disabled={running}
              style={{
                marginLeft: "auto",
                background: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "8px 14px",
                fontWeight: 600,
              }}
            >
              {running ? "Running…" : "Run Game"}
            </button>
            <button
              onClick={resetGame}
              disabled={running}
              style={{
                background: "#334155",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "8px 14px",
              }}
            >
              Reset
            </button>
          </div>
        </div>

        <PayoffEditor payoff={payoff} setPayoff={setPayoff} disabled={running} />

        {error && (
          <div className="card" style={{ borderColor: "#7f1d1d", color: "#fca5a5" }}>
            Error: {error}
          </div>
        )}

        <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <h3>Round history</h3>
          <div className="scroll" style={{ flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#8697b8" }}>
                  <th>#</th>
                  <th>{agentA.name}</th>
                  <th>{agentB.name}</th>
                  <th>Payoff</th>
                  <th>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r, i) => {
                  const cumA = history.slice(0, i + 1).reduce((s, x) => s + x.payoffA, 0);
                  const cumB = history.slice(0, i + 1).reduce((s, x) => s + x.payoffB, 0);
                  return (
                    <tr key={r.round} style={{ borderTop: "1px solid #1d2740" }}>
                      <td>{r.round}</td>
                      <td>
                        <span className={`badge ${r.moveA === "C" ? "coop" : "def"}`}>
                          {r.moveA === "C" ? "Cooperate" : "Defect"}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${r.moveB === "C" ? "coop" : "def"}`}>
                          {r.moveB === "C" ? "Cooperate" : "Defect"}
                        </span>
                      </td>
                      <td>
                        {r.payoffA} / {r.payoffB}
                      </td>
                      <td>
                        {cumA} / {cumB}
                      </td>
                    </tr>
                  );
                })}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ padding: 8 }}>
                      No rounds played yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* RIGHT — Agent B 30vw */}
      <section
        style={{
          width: "30vw",
          height: "100vh",
          borderLeft: "1px solid #1d2740",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          overflowY: "auto",
        }}
      >
        <AgentPanel
          title={agentB.name}
          color="#f87171"
          agent={agentB}
          setAgent={setAgentB}
          thinking={currentThinkingB}
          lastMove={history.at(-1)?.moveB}
          lastMessage={history.at(-1)?.messageB}
          score={totals.b}
          coopRate={coopRateB}
        />
      </section>
    </main>
  );
}

function Score({ name, score, color }: { name: string; score: number; color: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div className="muted">{name}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{score}</div>
    </div>
  );
}

function AgentPanel(props: {
  title: string;
  color: string;
  agent: AgentConfig;
  setAgent: (a: AgentConfig) => void;
  thinking: string;
  lastMove?: "C" | "D";
  lastMessage?: string;
  score: number;
  coopRate: number;
}) {
  const { title, color, agent, setAgent, thinking, lastMove, lastMessage, score, coopRate } = props;
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ color }}>{title}</h2>
          {lastMove && (
            <span className={`badge ${lastMove === "C" ? "coop" : "def"}`}>
              {lastMove === "C" ? "Cooperate" : "Defect"}
            </span>
          )}
        </div>
        <div className="muted">Score: {score} · Coop rate: {coopRate.toFixed(0)}%</div>
      </div>

      <div className="card col">
        <label className="muted">Name</label>
        <input value={agent.name} onChange={(e) => setAgent({ ...agent, name: e.target.value })} />
        <label className="muted">Model</label>
        <input value={agent.model} onChange={(e) => setAgent({ ...agent, model: e.target.value })} />
        <label className="muted">Temperature: {agent.temperature.toFixed(2)}</label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={agent.temperature}
          onChange={(e) => setAgent({ ...agent, temperature: parseFloat(e.target.value) })}
        />
        <label className="muted">Role / system prompt</label>
        <textarea
          rows={4}
          value={agent.role}
          onChange={(e) => setAgent({ ...agent, role: e.target.value })}
        />
      </div>

      <div className="card" style={{ flex: 1 }}>
        <h4>Current thinking</h4>
        <div className="thinking">{thinking || "—"}</div>
        {lastMessage && (
          <>
            <h4 style={{ marginTop: 10 }}>Last message</h4>
            <div className="thinking">“{lastMessage}”</div>
          </>
        )}
      </div>
    </>
  );
}

function PayoffEditor({
  payoff,
  setPayoff,
  disabled,
}: {
  payoff: PayoffMatrix;
  setPayoff: (p: PayoffMatrix) => void;
  disabled: boolean;
}) {
  const cell = (key: keyof PayoffMatrix, label: string) => (
    <div className="col" style={{ gap: 4 }}>
      <div className="muted">{label}</div>
      <div className="row">
        <input
          type="number"
          value={payoff[key][0]}
          disabled={disabled}
          style={{ width: 56 }}
          onChange={(e) =>
            setPayoff({ ...payoff, [key]: [parseInt(e.target.value || "0"), payoff[key][1]] })
          }
        />
        <span className="muted">/</span>
        <input
          type="number"
          value={payoff[key][1]}
          disabled={disabled}
          style={{ width: 56 }}
          onChange={(e) =>
            setPayoff({ ...payoff, [key]: [payoff[key][0], parseInt(e.target.value || "0")] })
          }
        />
      </div>
    </div>
  );
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Payoff matrix (A / B)</h3>
        <button
          onClick={() => setPayoff(DEFAULT_PAYOFF)}
          disabled={disabled}
          style={{ background: "transparent", color: "#8697b8", border: "1px solid #223049", borderRadius: 6, padding: "4px 8px" }}
        >
          Reset
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 6 }}>
        {cell("CC", "Both cooperate")}
        {cell("CD", "A coop / B defect")}
        {cell("DC", "A defect / B coop")}
        {cell("DD", "Both defect")}
      </div>
    </div>
  );
}
