import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  emptyMemory,
  ExperimentConditionId,
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

    const mode = body.mode === "independent" ? "independent" : "sequence";
    const sequences = clampInteger(body.sequences, 1, 500, 5);
    const episodesPerSequence = mode === "independent" ? 1 : clampInteger(body.episodesPerSequence, 1, 500, 10);
    const persistMemory = mode === "sequence" && Boolean(body.persistMemory);
    const requestedConditions = normalizeConditions(body.conditions, body.baseSession.config.conditionId);
    const isFullExperiment = requestedConditions.length > 1;
    const name = body.name?.trim() || (isFullExperiment ? `full-2x2-${mode}-experiment` : `${mode}-experiment`);
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
      communicationEnabled: isFullExperiment ? undefined : body.baseSession.config.communication,
      payoffObservability: isFullExperiment ? undefined : body.baseSession.config.payoffObservability,
    };

    await createExperimentDir(manifest, {
      manifest,
      baseSession: body.baseSession,
    requested: {
        mode,
        sequences,
        episodesPerSequence,
        persistMemory,
        conditions: requestedConditions,
      },
    });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const records: EpisodeRecord[] = [];
    const totalEpisodes = sequences * episodesPerSequence * requestedConditions.length;
    let completedEpisodes = 0;

    console.log(
      `[experiment:${id}] started conditions=${requestedConditions.join(",")} sequences=${sequences} episodesPerSequence=${episodesPerSequence} total=${totalEpisodes}`
    );

    for (const conditionId of requestedConditions) {
      const conditionSession = applyConditionToSession(body.baseSession, conditionId);
      console.log(`[experiment:${id}] condition ${conditionId} started`);

      for (let sequenceIndex = 0; sequenceIndex < sequences; sequenceIndex += 1) {
        const sequenceId = `${id}-${conditionId}-seq-${sequenceIndex + 1}`;
        let carriedAgents = resetAgentMemory(conditionSession.agents);
        console.log(`[experiment:${id}] condition=${conditionId} sequence ${sequenceIndex + 1}/${sequences} started`);

        for (let episodeIndex = 0; episodeIndex < episodesPerSequence; episodeIndex += 1) {
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

          await appendEpisode(record);
          records.push(record);
          completedEpisodes += 1;
          console.log(
            `[experiment:${id}] episode ${completedEpisodes}/${totalEpisodes} condition=${episode.config.conditionId} sequence=${sequenceIndex + 1} episode=${episodeIndex + 1} outcome=${episode.payoff?.outcome || "unfinished"} welfare=${episode.payoff?.welfare ?? "n/a"}`
          );
          carriedAgents = persistMemory ? revealEpisodeOutcome(episode) : resetAgentMemory(conditionSession.agents);
        }
      }
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
  const base = `Previous episode outcome: Agent A chose ${finalA}, Agent B chose ${finalB}.`;
  const publicPayoff = session.config.revealOpponentPayoffAfterEpisode
    ? ` Payoffs were Agent A ${payoffA}, Agent B ${payoffB}.`
    : "";

  return {
    A: {
      ...session.agents.A,
      memory: {
        ...session.agents.A.memory,
        observations: [
          ...session.agents.A.memory.observations,
          `${base} Your payoff was ${payoffA}.${publicPayoff}`,
        ].slice(-10),
      },
    },
    B: {
      ...session.agents.B,
      memory: {
        ...session.agents.B.memory,
        observations: [
          ...session.agents.B.memory.observations,
          `${base} Your payoff was ${payoffB}.${publicPayoff}`,
        ].slice(-10),
      },
    },
  };
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

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}
