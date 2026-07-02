import { NextResponse } from "next/server";
import { AgentId, ExperimentConditionId, NegotiationSession } from "@/lib/agents";
import {
  appendEpisode,
  createExperimentDir,
  createExperimentId,
  detectAlignment,
  EpisodeRecord,
  ExperimentManifest,
  summarize,
  updateManifest,
} from "@/lib/experiment-files";

export const runtime = "nodejs";

interface PilotEpisodeInput {
  session: NegotiationSession;
  conditionId: ExperimentConditionId;
  sequenceIndex: number;
  episodeIndex: number;
  firstSpeaker: AgentId;
  persistMemory?: boolean;
}

interface PilotSaveRequest {
  name?: string;
  baseSession?: NegotiationSession;
  persistMemory?: boolean;
  episodes?: PilotEpisodeInput[];
}

export async function POST(req: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      { ok: false, error: "Visible pilot runs can only be saved to local files on localhost." },
      { status: 400 }
    );
  }

  try {
    const body = (await req.json()) as PilotSaveRequest;
    const episodes = body.episodes || [];
    if (!body.baseSession) {
      return NextResponse.json({ ok: false, error: "baseSession is required." }, { status: 400 });
    }
    if (!episodes.length) {
      return NextResponse.json({ ok: false, error: "No pilot episodes supplied." }, { status: 400 });
    }

    const name = body.name?.trim() || "visible-pilot";
    const id = createExperimentId(name);
    const conditions = Array.from(new Set(episodes.map((episode) => episode.conditionId)));
    const persistMemory = body.persistMemory === true;
    const manifest: ExperimentManifest = {
      id,
      name,
      mode: "sequence",
      createdAt: new Date().toISOString(),
      status: "running",
      sequences: Math.max(...episodes.map((episode) => episode.sequenceIndex)),
      episodesPerSequence: Math.max(...episodes.map((episode) => episode.episodeIndex)),
      persistMemory,
      conditions,
    };

    await createExperimentDir(manifest, {
      manifest,
      baseSession: body.baseSession,
        requested: {
          source: "visible-pilot",
          conditions,
          persistMemory,
        },
      });

    const records: EpisodeRecord[] = [];
    for (const episode of episodes) {
      const session = episode.session;
      const sequenceId = `${id}-${episode.conditionId}-seq-${episode.sequenceIndex}`;
      const record: EpisodeRecord = {
        experimentId: id,
        sequenceId,
        sequenceIndex: episode.sequenceIndex,
        episodeId: `${sequenceId}-ep-${episode.episodeIndex}`,
        episodeIndex: episode.episodeIndex,
        mode: "sequence",
        persistMemory: episode.persistMemory === true,
        firstSpeaker: episode.firstSpeaker,
        status: session.status,
        config: session.config,
        agents: session.agents,
        transcript: session.transcript,
        events: session.events,
        finalDecisions: session.finalDecisions,
        payoff: session.payoff,
        alignment: detectAlignment(session),
        createdAt: new Date().toISOString(),
      };
      await appendEpisode(record);
      records.push(record);
    }

    const completedManifest: ExperimentManifest = {
      ...manifest,
      status: "completed",
      completedAt: new Date().toISOString(),
      summary: summarize(records),
    };
    await updateManifest(completedManifest);

    return NextResponse.json({ ok: true, manifest: completedManifest });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Could not save visible pilot." }, { status: 500 });
  }
}
