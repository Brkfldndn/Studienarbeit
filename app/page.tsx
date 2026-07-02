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
  SCENARIO_OPTIONS,
  ScenarioId,
  formatMoveForScenario,
  formatPayoffForScenario,
  getScenario,
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
    id: "public_communication",
    label: "Control: public profit information",
    communication: true,
    payoffObservability: "public",
  },
  {
    id: "private_communication",
    label: "Treatment: private profit information",
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
  status: "running" | "completed" | "error" | "cancelled";
  sequences: number;
  episodesPerSequence: number;
  persistMemory: boolean;
  conditions?: ExperimentConditionId[];
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

interface PilotEpisodeSave {
  session: NegotiationSession;
  conditionId: ExperimentConditionId;
  sequenceIndex: number;
  episodeIndex: number;
  firstSpeaker: AgentId;
  persistMemory: boolean;
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
  const [experimentName, setExperimentName] = useState("security-payoff-observability");
  const [experimentMode, setExperimentMode] = useState<"independent" | "sequence">("sequence");
  const [sequenceCount, setSequenceCount] = useState(30);
  const [episodesPerSequence, setEpisodesPerSequence] = useState(10);
  const [parallelSequences, setParallelSequences] = useState(4);
  const [persistMemory, setPersistMemory] = useState(false);
  const [experiments, setExperiments] = useState<ExperimentManifestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [payoffObservability, setPayoffObservability] = useState<PayoffObservability>("public");
  const [fullExperimentProgress, setFullExperimentProgress] = useState<string | null>(null);
  const [pilotProgress, setPilotProgress] = useState<string | null>(null);
  const [isHostedDeployment, setIsHostedDeployment] = useState(false);
  const scenario = getScenario(session.config.scenarioId);

  useEffect(() => {
    void refreshExperiments();
    setIsHostedDeployment(
      window.location.hostname.endsWith(".vercel.app") ||
        (!["localhost", "127.0.0.1"].includes(window.location.hostname) && !window.location.hostname.endsWith(".local"))
    );
  }, []);

  useEffect(() => {
    if (!experimentRunning) return;
    const timer = window.setInterval(() => {
      void refreshExperiments({ quiet: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [experimentRunning]);

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
  const pilotSequences = 5;
  const pilotEpisodesPerSequence = 1;
  const plannedPilotEpisodes = pilotSequences * pilotEpisodesPerSequence * CORE_CONDITIONS.length;
  const latestExperiment = experiments[0];
  const latestCompletedExperiment = latestExperiment?.status === "completed" ? latestExperiment : null;

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

  async function refreshExperiments(options: { quiet?: boolean } = {}) {
    try {
      const res = await fetch("/api/experiments");
      const data = await readJsonResponse<{ ok: true; experiments: ExperimentManifestView[] }>(
        res,
        "Could not load experiments."
      );
      setExperiments(data.experiments || []);
      if (!options.quiet) setError(null);
    } catch (err: any) {
      if (!options.quiet) setError(err?.message ?? "Could not load experiments.");
    }
  }

  async function runExperiment(
    baseSession = session,
    name = experimentName,
    conditions?: ExperimentConditionId[],
    overrides: Partial<{
      mode: "independent" | "sequence";
      sequences: number;
      episodesPerSequence: number;
      persistMemory: boolean;
      parallelSequences: number;
    }> = {}
  ) {
    setExperimentRunning(true);
    setError(null);
    try {
      const requestedMode = overrides.mode ?? experimentMode;
      const requestedSequences = overrides.sequences ?? sequenceCount;
      const requestedEpisodesPerSequence = overrides.episodesPerSequence ?? episodesPerSequence;
      const requestedParallelSequences = overrides.parallelSequences ?? parallelSequences;
      const res = await fetch("/api/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          mode: requestedMode,
          sequences: requestedSequences,
          episodesPerSequence: requestedEpisodesPerSequence,
          persistMemory: overrides.persistMemory ?? persistMemory,
          parallelSequences: requestedParallelSequences,
          baseSession,
          conditions,
        }),
      });
      const data = await readJsonResponse<{ ok: true; manifest?: ExperimentManifestView }>(res, "Experiment failed.");
      await refreshExperiments();
      if (data.manifest?.status === "completed") {
        const completedEpisodes =
          data.manifest.summary?.episodes ??
          (requestedMode === "sequence" ? requestedSequences * requestedEpisodesPerSequence : requestedSequences) *
            (conditions?.length || 1);
        setFullExperimentProgress(
          `Completed ${completedEpisodes} negotiations. Data saved in data/experiments/${data.manifest.id}.`
        );
      }
    } catch (err: any) {
      setError(err?.message ?? "Experiment failed.");
      throw err;
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
      setFullExperimentProgress(
        `Running payoff-observability experiment · ${plannedFullEpisodes} negotiations · ${parallelSequences} parallel sequences per condition`
      );
      await runExperiment(session, experimentName, CORE_CONDITIONS.map((condition) => condition.id));
      setFullExperimentProgress(`Completed ${plannedFullEpisodes} negotiations across the control and treatment. Data saved in data/experiments.`);
    } catch (err: any) {
      setError(err?.message ?? "Full experiment failed.");
    } finally {
      setExperimentRunning(false);
    }
  }

  async function startPilotExperiment() {
    setRunning(true);
    setError(null);
    setPilotProgress(`Pilot starting · 0/${plannedPilotEpisodes}`);
    try {
      const baseSession = session;
      let completed = 0;
      const pilotEpisodes: PilotEpisodeSave[] = [];

      for (const condition of CORE_CONDITIONS) {
        let carried = withCondition(baseSession, condition.id);
        setPayoffObservability(condition.payoffObservability);

        for (let episodeIndex = 0; episodeIndex < pilotSequences; episodeIndex += 1) {
          let current = episodeIndex === 0 ? carried : nextPilotEpisode(carried);
          const firstSpeaker = current.nextSpeaker;
          setSession(current);
          setPilotProgress(
            `Pilot running · ${completed}/${plannedPilotEpisodes} complete · ${condition.payoffObservability} episode ${episodeIndex + 1}/${pilotSequences}`
          );
          await waitForPaint();

          for (let step = 0; step < current.config.maxAutoSteps; step += 1) {
            if (
              current.status === "finished" ||
              (current.config.communication !== false && current.transcript.length >= current.config.maxMessages) ||
              (current.finalDecisions.A && current.finalDecisions.B)
            ) {
              break;
            }

            current = await requestStep(current);
            setSession(current);
            await waitForPaint();
          }

          carried = persistMemory ? rememberPilotOutcome(current) : withCondition(baseSession, condition.id);
          pilotEpisodes.push({
            session: current,
            conditionId: condition.id,
            sequenceIndex: 1,
            episodeIndex: episodeIndex + 1,
            firstSpeaker,
            persistMemory,
          });
          completed += 1;
          setPilotProgress(
            `Pilot running · ${completed}/${plannedPilotEpisodes} complete · last outcome ${current.payoff?.outcome || "unfinished"}`
          );
          await waitForPaint(400);
        }
      }

      setPilotProgress(`Pilot completed · saving ${plannedPilotEpisodes} negotiations`);
      const res = await fetch("/api/experiments/pilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${experimentName}-visible-pilot`,
          baseSession,
          persistMemory,
          episodes: pilotEpisodes,
        }),
      });
      const data = await readJsonResponse<{ ok: true; manifest?: ExperimentManifestView }>(
        res,
        "Could not save visible pilot."
      );
      await refreshExperiments();
      setPilotProgress(
        `Pilot completed and saved · ${data.manifest?.summary?.episodes ?? plannedPilotEpisodes} negotiations · ${data.manifest?.id ?? "saved"}`
      );
    } catch (err: any) {
      setError(err?.message ?? "Pilot experiment failed.");
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

  function applyScenario(scenarioId: ScenarioId) {
    const nextScenario = getScenario(scenarioId);
    setExperimentName(`${scenarioId}-payoff-observability`);
    setSession((current) => ({
      ...current,
      config: {
        ...current.config,
        scenarioId,
      },
      agents: {
        A: {
          ...current.agents.A,
          systemPrompt: nextScenario.defaultSystemPrompt,
          memory: emptyMemory(),
        },
        B: {
          ...current.agents.B,
          systemPrompt: nextScenario.defaultSystemPrompt,
          memory: emptyMemory(),
        },
      },
      transcript: [],
      events: [],
      finalDecisions: {},
      payoff: undefined,
      status: "idle",
      nextSpeaker: Math.random() < 0.5 ? "A" : "B",
    }));
    setError(null);
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
          <label className="scenario-select">
            Scenario
            <select
              value={session.config.scenarioId}
              disabled={running || experimentRunning}
              onChange={(event) => applyScenario(event.target.value as ScenarioId)}
            >
              {SCENARIO_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={startFullExperiment} disabled={running || experimentRunning || isHostedDeployment}>
            {experimentRunning ? "Running full experiment..." : "Run full experiment"}
          </button>
          <button onClick={startPilotExperiment} disabled={running || experimentRunning}>
            {running && pilotProgress ? "Running pilot..." : "Run 10-negotiation pilot"}
          </button>
          <button onClick={autoRun} disabled={!canStep || experimentRunning}>
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
      {pilotProgress && <div className="toast">{pilotProgress}</div>}
      {finishReason && <div className="toast">{finishReason} Use Reset run to start another negotiation.</div>}
      {latestCompletedExperiment && !experimentRunning && (
        <div className="toast">
          Full experiment completed: {latestCompletedExperiment.summary?.episodes ?? 0} negotiations saved to{" "}
          data/experiments/{latestCompletedExperiment.id}.
        </div>
      )}

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

          <details className="treatment-card compact-card" open>
            <summary className="section-heading">
              <span>Scenario prompt</span>
              <strong>{scenario.label}</strong>
            </summary>
            <p className="muted">{scenario.description}</p>
          </details>

          <details className="treatment-card" open>
            <summary className="section-heading">
              <span>{scenario.payoffNoun === "profit" ? "Profit Information" : "Payoff Information"}</span>
              <strong>
                {session.config.payoffObservability === "public" ? scenario.publicInfoLabel : scenario.privateInfoLabel}
              </strong>
            </summary>
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
            <PayoffEditor
              payoff={proposedUtilityMatrix}
              updatePayoff={() => undefined}
              disabled
              compact
              scenarioId={session.config.scenarioId}
            />
            <div className="diagnostics">
              <span className={utilityDiagnostics.cooperationMaximizesWelfare ? "chip good" : "chip bad"}>
                welfare: C/C {utilityDiagnostics.welfare.CC}
              </span>
              <span className="chip">
                asymmetric {utilityDiagnostics.welfare.CD}/{utilityDiagnostics.welfare.DC}
              </span>
            </div>
          </details>

          <details className="treatment-card compact-card" open>
            <summary className="section-heading">
              <span>Communication</span>
              <strong>{session.config.communication ? "Free-text chat" : "No communication"}</strong>
            </summary>
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
          </details>

          <details className="treatment-card compact-card" open>
            <summary className="section-heading">
              <span>Memory</span>
              <strong>{session.config.useAgentNotes ? "History + agent notes" : "Outcome history only"}</strong>
            </summary>
            <div className="segmented two">
              <button
                className={!session.config.useAgentNotes ? "selected" : ""}
                disabled={running}
                onClick={() =>
                  setSession((current) => ({
                    ...current,
                    config: { ...current.config, useAgentNotes: false },
                    agents: {
                      A: { ...current.agents.A, memory: emptyMemory() },
                      B: { ...current.agents.B, memory: emptyMemory() },
                    },
                  }))
                }
              >
                History only
              </button>
              <button
                className={session.config.useAgentNotes ? "selected" : ""}
                disabled={running}
                onClick={() =>
                  setSession((current) => ({
                    ...current,
                    config: { ...current.config, useAgentNotes: true },
                  }))
                }
              >
                Agent notes
              </button>
            </div>
          </details>

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
                <summary>Manual profit schedule override</summary>
                <PayoffEditor
                  payoff={session.config.actualPayoff}
                  updatePayoff={updateActualPayoff}
                  disabled={running}
                  scenarioId={session.config.scenarioId}
                />
              </details>
            </div>
          </details>

          <details className="experiment-runner" open>
            <summary className="section-heading">
              <span>Full experiment</span>
              <strong>Profit-information treatment</strong>
            </summary>
            <p className="muted">
              One click runs the communication-enabled control and treatment, then writes manifest, config, summary CSV, episodes,
              messages, and model calls to
              <code> data/experiments</code>.
              Cross-episode memory is off by default; sequences are replication blocks.
              Scenario: {scenario.label}.
            </p>
            {isHostedDeployment && (
              <p className="warning-text">
                Full experiments must run on localhost. Vercel requests will time out and do not give you durable local files.
              </p>
            )}
            <div className="config-row">
              <label className="wide-label">
                Name
                <input value={experimentName} onChange={(event) => setExperimentName(event.target.value)} />
              </label>
              <label>
                Sequences
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
              <label>
                Parallel sequences
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={parallelSequences}
                  onChange={(event) => setParallelSequences(parseInt(event.target.value || "1", 10))}
                />
              </label>
            </div>
            <div className="run-summary">
              <span>2 conditions</span>
              <span>{sequenceCount} sequences each</span>
              <span>{episodesPerSequence} episodes each</span>
              <span>{parallelSequences} parallel sequences / condition</span>
              <span>{persistMemory ? "memory carried" : "memory reset each episode"}</span>
              <strong>{plannedFullEpisodes} total negotiations</strong>
            </div>
            <div className="button-row">
              <button className="primary" onClick={startFullExperiment} disabled={running || experimentRunning || isHostedDeployment}>
                {experimentRunning ? "Running..." : "Run full experiment"}
              </button>
              <button onClick={() => void refreshExperiments()} disabled={experimentRunning}>
                Refresh saved data
              </button>
            </div>
            {fullExperimentProgress && <p className="progress-text">{fullExperimentProgress}</p>}
            {latestCompletedExperiment && (
              <div className="saved-run">
                <strong>Latest completed run</strong>
                <span>{latestCompletedExperiment.summary?.episodes ?? 0} negotiations · {latestCompletedExperiment.id}</span>
                <div className="experiment-links">
                  <a href={`/api/experiments/${latestCompletedExperiment.id}/file?file=manifest.json`}>manifest</a>
                  <a href={`/api/experiments/${latestCompletedExperiment.id}/file?file=summary.csv`}>summary</a>
                  <a href={`/api/experiments/${latestCompletedExperiment.id}/file?file=episodes.jsonl`}>episodes</a>
                  <a href={`/api/experiments/${latestCompletedExperiment.id}/file?file=messages.jsonl`}>messages</a>
                </div>
              </div>
            )}
            <ExperimentList experiments={experiments} />
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
                <label>
                  Parallel sequences
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={parallelSequences}
                    disabled={experimentMode === "independent"}
                    onChange={(event) => setParallelSequences(parseInt(event.target.value || "1", 10))}
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
                <button onClick={() => void refreshExperiments()} disabled={experimentRunning}>
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
              <span className="muted">{scenario.shortLabel} · {session.agents.A.model} / {session.agents.B.model}</span>
            </summary>
            <div className="agent-pair">
              <AgentPanel
                agent={session.agents.A}
                updateAgent={(patch) => updateAgent("A", patch)}
                disabled={running || session.transcript.length > 0}
                scenarioId={session.config.scenarioId}
              />
              <AgentPanel
                agent={session.agents.B}
                updateAgent={(patch) => updateAgent("B", patch)}
                disabled={running || session.transcript.length > 0}
                scenarioId={session.config.scenarioId}
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
                {experiment.status} · {experiment.mode} · {experiment.conditions?.length || 1} condition(s) ·{" "}
                {summary?.episodes ?? experiment.sequences} episodes
                {summary
                  ? ` · C/C ${summary.outcomes.CC || 0}, C/D ${summary.outcomes.CD || 0}, D/C ${summary.outcomes.DC || 0}, D/D ${summary.outcomes.DD || 0}`
                  : ""}
              </p>
              {summary && (
                <p className="muted">
                  C-rate A {(summary.cooperationA * 100).toFixed(0)}%, C-rate B {(summary.cooperationB * 100).toFixed(0)}% · avg payoff{" "}
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

function nextPilotEpisode(session: NegotiationSession): NegotiationSession {
  return {
    ...session,
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    transcript: [],
    events: [],
    finalDecisions: {},
    payoff: undefined,
    nextSpeaker: Math.random() < 0.5 ? "A" : "B",
    status: "idle",
  };
}

function rememberPilotOutcome(session: NegotiationSession): NegotiationSession {
  const finalA = session.finalDecisions.A?.move || "?";
  const finalB = session.finalDecisions.B?.move || "?";
  const profitA = session.payoff?.a ?? "unknown";
  const profitB = session.payoff?.b ?? "unknown";
  const scenario = getScenario(session.config.scenarioId);
  const publicA = session.config.revealOpponentPayoffAfterEpisode
    ? ` Counterpart ${scenario.payoffNoun} was ${formatScenarioPayoff(profitB, scenario.id)}.`
    : "";
  const publicB = session.config.revealOpponentPayoffAfterEpisode
    ? ` Counterpart ${scenario.payoffNoun} was ${formatScenarioPayoff(profitA, scenario.id)}.`
    : "";

  return {
    ...session,
    agents: {
      A: {
        ...session.agents.A,
        memory: appendMemoryLine(
          session.agents.A.memory,
          `Observed counterpart outcome: counterpart chose ${formatScenarioMove(finalB, scenario.id)}; you chose ${formatScenarioMove(finalA, scenario.id)}; you received ${formatScenarioPayoff(profitA, scenario.id)}.${publicA}`
        ),
      },
      B: {
        ...session.agents.B,
        memory: appendMemoryLine(
          session.agents.B.memory,
          `Observed counterpart outcome: counterpart chose ${formatScenarioMove(finalA, scenario.id)}; you chose ${formatScenarioMove(finalB, scenario.id)}; you received ${formatScenarioPayoff(profitB, scenario.id)}.${publicB}`
        ),
      },
    },
  };
}

function appendMemoryLine(memory: string, line: string) {
  const current = memory && memory !== "No negotiation-specific memory yet." ? memory : "";
  return [current, line].filter(Boolean).join("\n").split("\n").slice(-10).join("\n");
}

function formatScenarioMove(move: string, scenarioId?: ScenarioId) {
  return formatMoveForScenario(move, scenarioId);
}

function formatScenarioPayoff(value: number | string, scenarioId?: ScenarioId) {
  return typeof value === "number" ? formatPayoffForScenario(value, scenarioId) : String(value);
}

function waitForPaint(ms = 80) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function AgentPanel({
  agent,
  updateAgent,
  disabled,
  scenarioId,
}: {
  agent: NegotiationAgentConfig;
  updateAgent: (patch: Partial<NegotiationAgentConfig>) => void;
  disabled: boolean;
  scenarioId: ScenarioId;
}) {
  const scenario = getScenario(scenarioId);
  return (
    <div className="agent-stack">
      <details className="agent-card" style={{ borderColor: agentColor[agent.id] }} open>
        <summary className="row-between">
          <div>
            <p className="muted">Agent {agent.id}</p>
            <h2 style={{ color: agentColor[agent.id] }}>{agent.name}</h2>
          </div>
          <div className="avatar" style={{ background: agentColor[agent.id] }}>
            {agent.id}
          </div>
        </summary>
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
      </details>

      <details className="panel-section" open>
        <summary>
          <h3>System Prompt</h3>
          <span className="muted">{scenario.label}</span>
        </summary>
        <textarea
          rows={7}
          value={agent.systemPrompt}
          onChange={(event) => updateAgent({ systemPrompt: event.target.value })}
        />
      </details>

      <details className="panel-section memory" open>
        <summary>
          <h3>Observed History</h3>
        </summary>
        <pre>{formatMemoryScratchpad(agent.memory)}</pre>
      </details>
    </div>
  );
}

function formatMemoryScratchpad(memory: unknown) {
  if (typeof memory === "string") return memory || "No negotiation-specific memory yet.";
  if (!memory || typeof memory !== "object") return "No negotiation-specific memory yet.";
  const legacy = memory as {
    summary?: string;
    commitments?: string[];
    observations?: string[];
    strategyNotes?: string[];
  };
  return [
    legacy.summary,
    ...(legacy.commitments || []),
    ...(legacy.observations || []),
    ...(legacy.strategyNotes || []),
  ]
    .filter(Boolean)
    .join("\n");
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
  const scenario = getScenario(session.config.scenarioId);
  return (
    <div className="final-card" style={{ borderColor: agentColor[agent] }}>
      <strong>{session.agents[agent].name} final</strong>
      {decision ? (
        <>
          <span className={`badge ${decision.move === "C" ? "coop" : "def"}`}>
            {formatScenarioMove(decision.move, scenario.id)}
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
  scenarioId = "pricing_duopoly",
}: {
  payoff: PayoffMatrix;
  updatePayoff: (key: keyof PayoffMatrix, index: 0 | 1, value: number) => void;
  disabled: boolean;
  compact?: boolean;
  scenarioId?: ScenarioId;
}) {
  const scenario = getScenario(scenarioId);
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
      {cell("CC", `Both ${scenario.actionCDescription}`, ["C", "C"])}
      {cell("CD", `A ${scenario.actionCDescription}, B ${scenario.actionDDescription}`, ["C", "D"])}
      {cell("DC", `A ${scenario.actionDDescription}, B ${scenario.actionCDescription}`, ["D", "C"])}
      {cell("DD", `Both ${scenario.actionDDescription}`, ["D", "D"])}
    </div>
  );
}
