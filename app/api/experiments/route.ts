import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  emptyMemory,
  ExperimentConditionId,
  formatMoveForScenario,
  formatPayoffForScenario,
  getScenario,
  makeEvent,
  NegotiationAgentConfig,
  NegotiationSession,
  PayoffObservability,
} from "@/lib/agents";
import {
  appendEpisode,
  createExperimentDir,
  createExperimentId,
  detectAlignment,
  EpisodeRecord,
  ExperimentManifest,
  isExperimentCancelled,
  listExperiments,
  summarize,
  updateManifest,
} from "@/lib/experiment-files";
import { runNegotiationStep } from "@/lib/server-negotiation";

export const runtime = "nodejs";
export const maxDuration = 60;

type ExperimentMode = "independent" | "sequence";

interface ExperimentRequest {
  name?: string;
  mode?: ExperimentMode;
  sequences?: number;
  episodesPerSequence?: number;
  persistMemory?: boolean;
  parallelSequences?: number;
  baseSession?: NegotiationSession;
  conditions?: ExperimentConditionId[];
}

const CORE_CONDITIONS: Array<{
  id: ExperimentConditionId;
  communication: boolean;
  payoffObservability: PayoffObservability;
}> = [
  { id: "public_no_communication", communication: false, payoffObservability: "public" },
  { id: "public_communication", communication: true, payoffObservability: "public" },
  { id: "private_no_communication", communication: false, payoffObservability: "private" },
  { id: "private_communication", communication: true, payoffObservability: "private" },
];

export async function GET() {
  try {
    return NextResponse.json({ ok: true, experiments: await listExperiments() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Could not load experiments." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Batch experiments cannot run inside a single Vercel request. Use the live app for one negotiation at a time, or run batches locally / in a background worker.",
      },
      { status: 400 }
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  let manifest: ExperimentManifest | undefined;

  try {
    const body = (await req.json()) as ExperimentRequest;
    if (!body.baseSession) {
      return NextResponse.json({ ok: false, error: "baseSession is required." }, { status: 400 });
    }
    const baseSession = body.baseSession;

    const mode = body.mode === "independent" ? "independent" : "sequence";
    const sequences = clampInteger(body.sequences, 1, 500, 30);
    const episodesPerSequence = mode === "independent" ? 1 : clampInteger(body.episodesPerSequence, 1, 500, 10);
    const persistMemory = mode === "sequence" && body.persistMemory === true;
    const parallelSequences = clampInteger(body.parallelSequences, 1, 12, 4);
    const requestedConditions = normalizeConditions(body.conditions, baseSession.config.conditionId);
    const isFullExperiment = requestedConditions.length > 1;
    const name = body.name?.trim() || (isFullExperiment ? `payoff-observability-${mode}-experiment` : `${mode}-experiment`);
    const id = createExperimentId(name);

    manifest = {
      id,
      name,
      mode,
      createdAt: new Date().toISOString(),
      status: "running",
      sequences,
      episodesPerSequence,
      persistMemory,
      conditionId: isFullExperiment ? undefined : requestedConditions[0],
      conditions: requestedConditions,
      communicationEnabled: isFullExperiment ? undefined : baseSession.config.communication,
      payoffObservability: isFullExperiment ? undefined : baseSession.config.payoffObservability,
    };

    await createExperimentDir(manifest, {
      manifest,
      baseSession,
    requested: {
        mode,
        sequences,
        episodesPerSequence,
        persistMemory,
        parallelSequences,
        conditions: requestedConditions,
      },
    });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const records: EpisodeRecord[] = [];
    const totalEpisodes = sequences * episodesPerSequence * requestedConditions.length;
    let completedEpisodes = 0;
    let cancelled = false;
    let appendQueue: Promise<void> = Promise.resolve();

    console.log(
      `[experiment:${id}] started conditions=${requestedConditions.join(",")} sequences=${sequences} episodesPerSequence=${episodesPerSequence} total=${totalEpisodes}`
    );

    async function appendEpisodeQueued(record: EpisodeRecord) {
      appendQueue = appendQueue.then(() => appendEpisode(record));
      await appendQueue;
    }

    async function runSequence(conditionId: ExperimentConditionId, conditionSession: NegotiationSession, sequenceIndex: number) {
      if (cancelled) return;
      const sequenceId = `${id}-${conditionId}-seq-${sequenceIndex + 1}`;
      let carriedAgents = resetAgentMemory(conditionSession.agents);
      console.log(`[experiment:${id}] condition=${conditionId} sequence ${sequenceIndex + 1}/${sequences} started`);

      for (let episodeIndex = 0; episodeIndex < episodesPerSequence; episodeIndex += 1) {
        if (cancelled) return;
        if (await isExperimentCancelled(id)) {
          cancelled = true;
          return;
        }

        const firstSpeaker = randomAgent();
        let episode = createEpisodeSession({
          baseSession: conditionSession,
          id: `${sequenceId}-ep-${episodeIndex + 1}`,
          firstSpeaker,
          agents: carriedAgents,
        });

        const maxSteps = Math.max(episode.config.maxAutoSteps, episode.config.maxMessages + 4);
        for (let step = 0; step < maxSteps; step += 1) {
          if (
            episode.status === "finished" ||
            (episode.config.communication !== false && episode.transcript.length >= episode.config.maxMessages) ||
            (episode.finalDecisions.A && episode.finalDecisions.B)
          ) {
            break;
          }

          episode = await runNegotiationStep({ client, session: episode });
        }

        if (episode.status !== "finished") {
          episode = {
            ...episode,
            status: "finished",
            events: [
              ...episode.events,
              makeEvent({
                turn: episode.transcript.length + Object.keys(episode.finalDecisions).length + 1,
                type: "session_finished",
                content: "Experiment step cap reached before both agents finalized.",
              }),
            ],
          };
        }

        const record: EpisodeRecord = {
          experimentId: id,
          sequenceId,
          sequenceIndex: sequenceIndex + 1,
          episodeId: episode.id,
          episodeIndex: episodeIndex + 1,
          mode,
          persistMemory,
          firstSpeaker,
          status: episode.status,
          config: episode.config,
          agents: episode.agents,
          transcript: episode.transcript,
          events: episode.events,
          finalDecisions: episode.finalDecisions,
          payoff: episode.payoff,
          alignment: detectAlignment(episode),
          createdAt: new Date().toISOString(),
        };

        await appendEpisodeQueued(record);
        records.push(record);
        completedEpisodes += 1;
        console.log(
          `[experiment:${id}] episode ${completedEpisodes}/${totalEpisodes} condition=${episode.config.conditionId} sequence=${sequenceIndex + 1} episode=${episodeIndex + 1} outcome=${episode.payoff?.outcome || "unfinished"} welfare=${episode.payoff?.welfare ?? "n/a"}`
        );
        carriedAgents = persistMemory ? revealEpisodeOutcome(episode) : resetAgentMemory(conditionSession.agents);
      }
    }

    async function runCondition(conditionId: ExperimentConditionId) {
      const conditionSession = applyConditionToSession(baseSession, conditionId);
      console.log(`[experiment:${id}] condition ${conditionId} started`);

      await runWithConcurrency(
        Array.from({ length: sequences }, (_, sequenceIndex) => sequenceIndex),
        parallelSequences,
        (sequenceIndex) => runSequence(conditionId, conditionSession, sequenceIndex)
      );
    }

    await Promise.all(requestedConditions.map((conditionId) => runCondition(conditionId)));
    await appendQueue;

    if (cancelled) {
      manifest = {
        ...manifest,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        summary: summarize(records),
        error: "Experiment cancelled by user.",
      };
      await updateManifest(manifest);
      console.log(`[experiment:${id}] cancelled episodes=${records.length}`);
      return NextResponse.json({ ok: true, manifest });
    }

    manifest = {
      ...manifest,
      status: "completed",
      completedAt: new Date().toISOString(),
      summary: summarize(records),
    };
    await updateManifest(manifest);
    console.log(`[experiment:${id}] completed episodes=${records.length}`);

    return NextResponse.json({ ok: true, manifest });
  } catch (err: any) {
    if (manifest) {
      console.error(`[experiment:${manifest.id}] failed`, err);
      await updateManifest({
        ...manifest,
        status: "error",
        completedAt: new Date().toISOString(),
        error: err?.message || "Experiment failed.",
      });
    }

    return NextResponse.json({ ok: false, error: err?.message || "Experiment failed." }, { status: 500 });
  }
}

function normalizeConditions(
  conditions: ExperimentConditionId[] | undefined,
  fallback: ExperimentConditionId
): ExperimentConditionId[] {
  const valid = new Set(CORE_CONDITIONS.map((condition) => condition.id));
  const requested = conditions?.filter((condition) => valid.has(condition)) || [];
  if (requested.length) return Array.from(new Set(requested));
  return valid.has(fallback) ? [fallback] : ["public_communication"];
}

function applyConditionToSession(session: NegotiationSession, conditionId: ExperimentConditionId): NegotiationSession {
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
    },
    agents: resetAgentMemory(session.agents),
    transcript: [],
    events: [],
    finalDecisions: {},
    payoff: undefined,
    status: "idle",
  };
}

function revealEpisodeOutcome(session: NegotiationSession): NegotiationSession["agents"] {
  const finalA = session.finalDecisions.A?.move || "?";
  const finalB = session.finalDecisions.B?.move || "?";
  const payoffA = session.payoff?.a ?? "unknown";
  const payoffB = session.payoff?.b ?? "unknown";
  const scenario = getScenario(session.config.scenarioId);
  const publicA = session.config.revealOpponentPayoffAfterEpisode
    ? ` Counterpart ${scenario.payoffNoun} was ${formatScenarioPayoff(payoffB, scenario.id)}.`
    : "";
  const publicB = session.config.revealOpponentPayoffAfterEpisode
    ? ` Counterpart ${scenario.payoffNoun} was ${formatScenarioPayoff(payoffA, scenario.id)}.`
    : "";

  return {
    A: {
      ...session.agents.A,
      memory: appendScratchpad(
        session.agents.A.memory,
        `Observed counterpart outcome: counterpart chose ${formatScenarioMove(finalB, scenario.id)}; you chose ${formatScenarioMove(finalA, scenario.id)}; you received ${formatScenarioPayoff(payoffA, scenario.id)}.${publicA}`
      ),
    },
    B: {
      ...session.agents.B,
      memory: appendScratchpad(
        session.agents.B.memory,
        `Observed counterpart outcome: counterpart chose ${formatScenarioMove(finalA, scenario.id)}; you chose ${formatScenarioMove(finalB, scenario.id)}; you received ${formatScenarioPayoff(payoffB, scenario.id)}.${publicB}`
      ),
    },
  };
}

function appendScratchpad(memory: string, note: string) {
  const current = memory && memory !== "No negotiation-specific memory yet." ? memory : "";
  return [current, note].filter(Boolean).join("\n").split("\n").slice(-10).join("\n");
}

function formatScenarioMove(move: string, scenarioId?: NegotiationSession["config"]["scenarioId"]) {
  return formatMoveForScenario(move, scenarioId);
}

function formatScenarioPayoff(value: number | string, scenarioId?: NegotiationSession["config"]["scenarioId"]) {
  return typeof value === "number" ? formatPayoffForScenario(value, scenarioId) : String(value);
}

function createEpisodeSession(input: {
  baseSession: NegotiationSession;
  id: string;
  firstSpeaker: "A" | "B";
  agents: NegotiationSession["agents"];
}): NegotiationSession {
  return {
    ...input.baseSession,
    id: input.id,
    status: "running",
    agents: input.agents,
    transcript: [],
    events: [
      makeEvent({
        turn: 0,
        type: "session_started",
        content: "Experiment episode started.",
      }),
    ],
    finalDecisions: {},
    payoff: undefined,
    nextSpeaker: input.firstSpeaker,
  };
}

function resetAgentMemory(agents: NegotiationSession["agents"]): NegotiationSession["agents"] {
  return {
    A: resetOneAgent(agents.A),
    B: resetOneAgent(agents.B),
  };
}

function resetOneAgent(agent: NegotiationAgentConfig): NegotiationAgentConfig {
  return {
    ...agent,
    memory: emptyMemory(),
  };
}

function randomAgent(): "A" | "B" {
  return Math.random() < 0.5 ? "A" : "B";
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    })
  );
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}
