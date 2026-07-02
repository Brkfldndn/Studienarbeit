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
  detectAlignment,
  EpisodeRecord,
  ExperimentManifest,
  isExperimentCancelled,
  readExperimentFile,
  readExperimentRecords,
  summarize,
  updateManifest,
} from "@/lib/experiment-files";
import { runNegotiationStep } from "@/lib/server-negotiation";

export const runtime = "nodejs";
export const maxDuration = 60;

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

interface StoredConfig {
  manifest: ExperimentManifest;
  baseSession: NegotiationSession;
  requested?: {
    conditions?: ExperimentConditionId[];
  };
}

export async function POST(_: Request, { params }: { params: { id: string } }) {
  if (process.env.VERCEL) {
    return NextResponse.json({ ok: false, error: "Resume is local-only because Vercel requests time out." }, { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  const id = params.id;
  let manifest: ExperimentManifest | undefined;

  try {
    manifest = JSON.parse(await readExperimentFile(id, "manifest.json")) as ExperimentManifest;
    const stored = JSON.parse(await readExperimentFile(id, "config.json")) as StoredConfig;
    const baseSession = stored.baseSession;

    if (!baseSession) {
      return NextResponse.json({ ok: false, error: "Stored config does not include baseSession." }, { status: 400 });
    }

    const conditions = (manifest.conditions?.length ? manifest.conditions : stored.requested?.conditions) || [
      manifest.conditionId || "public_communication",
    ];
    const sequences = manifest.sequences;
    const episodesPerSequence = manifest.episodesPerSequence;
    const mode = manifest.mode;
    const persistMemory = manifest.persistMemory;
    const existingRecords = await readExperimentRecords(id);
    const existingKeys = new Set(
      existingRecords.map((record) => `${record.config.conditionId}:${record.sequenceIndex}:${record.episodeIndex}`)
    );
    const totalEpisodes = sequences * episodesPerSequence * conditions.length;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const records = [...existingRecords];
    let added = 0;
    let cancelled = false;

    manifest = {
      ...manifest,
      status: "running",
      error: undefined,
      summary: summarize(records),
    };
    await updateManifest(manifest);

    console.log(
      `[experiment:${id}] resume started existing=${existingRecords.length} target=${totalEpisodes} conditions=${conditions.join(",")}`
    );

    async function resumeCondition(conditionId: ExperimentConditionId) {
      const conditionSession = applyConditionToSession(baseSession, conditionId);

      for (let sequenceIndex = 0; sequenceIndex < sequences; sequenceIndex += 1) {
        if (cancelled) return;
        let carriedAgents = resetAgentMemory(conditionSession.agents);

        if (persistMemory) {
          carriedAgents = rebuildCarriedMemory({
            conditionSession,
            conditionId,
            sequenceIndex: sequenceIndex + 1,
            existingRecords,
          });
        }

        for (let episodeIndex = 0; episodeIndex < episodesPerSequence; episodeIndex += 1) {
          if (cancelled) return;
          const key = `${conditionId}:${sequenceIndex + 1}:${episodeIndex + 1}`;
          if (existingKeys.has(key)) continue;

          if (await isExperimentCancelled(id)) {
            cancelled = true;
            return;
          }

          const sequenceId = `${id}-${conditionId}-seq-${sequenceIndex + 1}`;
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
          existingKeys.add(key);
          added += 1;
          console.log(
            `[experiment:${id}] resumed ${records.length}/${totalEpisodes} condition=${conditionId} sequence=${
              sequenceIndex + 1
            } episode=${episodeIndex + 1} outcome=${episode.payoff?.outcome || "unfinished"} welfare=${
              episode.payoff?.welfare ?? "n/a"
            }`
          );

          carriedAgents = persistMemory ? revealEpisodeOutcome(episode) : resetAgentMemory(conditionSession.agents);
        }
      }
    }

    await Promise.all(conditions.map((conditionId) => resumeCondition(conditionId)));

    if (cancelled) {
      manifest = {
        ...manifest,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        summary: summarize(records),
        error: "Experiment cancelled by user.",
      };
      await updateManifest(manifest);
      return NextResponse.json({ ok: true, manifest, added });
    }

    manifest = {
      ...manifest,
      status: "completed",
      completedAt: new Date().toISOString(),
      summary: summarize(records),
    };
    await updateManifest(manifest);
    console.log(`[experiment:${id}] resume completed added=${added} total=${records.length}`);

    return NextResponse.json({ ok: true, manifest, added });
  } catch (err: any) {
    if (manifest) {
      await updateManifest({
        ...manifest,
        status: "error",
        completedAt: new Date().toISOString(),
        error: err?.message || "Experiment resume failed.",
      });
    }

    console.error(`[experiment:${id}] resume failed`, err);
    return NextResponse.json({ ok: false, error: err?.message || "Experiment resume failed." }, { status: 500 });
  }
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

function rebuildCarriedMemory(input: {
  conditionSession: NegotiationSession;
  conditionId: ExperimentConditionId;
  sequenceIndex: number;
  existingRecords: EpisodeRecord[];
}) {
  return input.existingRecords
    .filter(
      (record) =>
        record.config.conditionId === input.conditionId &&
        record.sequenceIndex === input.sequenceIndex &&
        record.episodeIndex < input.conditionSession.config.maxAutoSteps
    )
    .sort((a, b) => a.episodeIndex - b.episodeIndex)
    .reduce((agents, record) => revealEpisodeOutcome({ ...input.conditionSession, ...record, agents }), resetAgentMemory(input.conditionSession.agents));
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
        content: "Experiment episode resumed.",
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
