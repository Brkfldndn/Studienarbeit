import { NextResponse } from "next/server";
import OpenAI from "openai";
import { emptyMemory, makeEvent, NegotiationAgentConfig, NegotiationSession } from "@/lib/agents";
import {
  appendEpisode,
  createExperimentDir,
  createExperimentId,
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
}

export async function GET() {
  try {
    return NextResponse.json({ ok: true, experiments: await listExperiments() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Could not load experiments." }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
    const name = body.name?.trim() || `${mode}-experiment`;
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
    };

    await createExperimentDir(manifest, {
      manifest,
      baseSession: body.baseSession,
      requested: {
        mode,
        sequences,
        episodesPerSequence,
        persistMemory,
      },
    });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const records: EpisodeRecord[] = [];

    for (let sequenceIndex = 0; sequenceIndex < sequences; sequenceIndex += 1) {
      const sequenceId = `${id}-seq-${sequenceIndex + 1}`;
      let carriedAgents = resetAgentMemory(body.baseSession.agents);

      for (let episodeIndex = 0; episodeIndex < episodesPerSequence; episodeIndex += 1) {
        const firstSpeaker = randomAgent();
        let episode = createEpisodeSession({
          baseSession: body.baseSession,
          id: `${sequenceId}-ep-${episodeIndex + 1}`,
          firstSpeaker,
          agents: carriedAgents,
        });

        const maxSteps = Math.max(episode.config.maxAutoSteps, episode.config.maxMessages + 4);
        for (let step = 0; step < maxSteps; step += 1) {
          if (
            episode.status === "finished" ||
            episode.transcript.length >= episode.config.maxMessages ||
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
          createdAt: new Date().toISOString(),
        };

        await appendEpisode(record);
        records.push(record);
        carriedAgents = persistMemory ? episode.agents : resetAgentMemory(body.baseSession.agents);
      }
    }

    manifest = {
      ...manifest,
      status: "completed",
      completedAt: new Date().toISOString(),
      summary: summarize(records),
    };
    await updateManifest(manifest);

    return NextResponse.json({ ok: true, manifest });
  } catch (err: any) {
    if (manifest) {
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
