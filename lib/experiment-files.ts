import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AgentId, NegotiationEvent, NegotiationSession, TranscriptMessage } from "./agents";

const DATA_ROOT =
  process.env.EXPERIMENT_DATA_DIR ||
  (process.env.VERCEL ? path.join(os.tmpdir(), "llm-negotiation-experiments") : path.join(process.cwd(), "data", "experiments"));

export interface ExperimentManifest {
  id: string;
  name: string;
  mode: "independent" | "sequence";
  createdAt: string;
  completedAt?: string;
  status: "running" | "completed" | "error";
  sequences: number;
  episodesPerSequence: number;
  persistMemory: boolean;
  summary?: ExperimentSummary;
  error?: string;
}

export interface ExperimentSummary {
  episodes: number;
  sequences: number;
  outcomes: Record<string, number>;
  cooperationA: number;
  cooperationB: number;
  averagePayoffA: number;
  averagePayoffB: number;
  averageWelfare: number;
  totalTokens: number;
}

export interface EpisodeRecord {
  experimentId: string;
  sequenceId: string;
  sequenceIndex: number;
  episodeId: string;
  episodeIndex: number;
  mode: "independent" | "sequence";
  persistMemory: boolean;
  firstSpeaker: AgentId;
  status: NegotiationSession["status"];
  config: NegotiationSession["config"];
  agents: NegotiationSession["agents"];
  transcript: TranscriptMessage[];
  events: NegotiationEvent[];
  finalDecisions: NegotiationSession["finalDecisions"];
  payoff: NegotiationSession["payoff"];
  createdAt: string;
}

export function createExperimentId(name: string): string {
  const safeName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName || "experiment"}`;
}

export async function createExperimentDir(manifest: ExperimentManifest, config: unknown = manifest) {
  const dir = experimentDir(manifest.id);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "manifest.json"), manifest);
  await writeJson(path.join(dir, "config.json"), config);
  await fs.writeFile(path.join(dir, "episodes.jsonl"), "");
  await fs.writeFile(path.join(dir, "messages.jsonl"), "");
  await fs.writeFile(path.join(dir, "model_calls.jsonl"), "");
  await fs.writeFile(path.join(dir, "summary.csv"), summaryCsvHeader());
}

export async function updateManifest(manifest: ExperimentManifest) {
  await writeJson(path.join(experimentDir(manifest.id), "manifest.json"), manifest);
}

export async function appendEpisode(record: EpisodeRecord) {
  const dir = experimentDir(record.experimentId);
  await appendJsonl(path.join(dir, "episodes.jsonl"), compactEpisode(record));
  await fs.appendFile(path.join(dir, "summary.csv"), summaryCsvRow(record));

  for (const message of record.transcript) {
    await appendJsonl(path.join(dir, "messages.jsonl"), {
      experimentId: record.experimentId,
      sequenceId: record.sequenceId,
      episodeId: record.episodeId,
      sequenceIndex: record.sequenceIndex,
      episodeIndex: record.episodeIndex,
      ...message,
    });
  }

  for (const event of record.events) {
    if (!event.raw && !event.prompt) continue;
    await appendJsonl(path.join(dir, "model_calls.jsonl"), {
      experimentId: record.experimentId,
      sequenceId: record.sequenceId,
      episodeId: record.episodeId,
      sequenceIndex: record.sequenceIndex,
      episodeIndex: record.episodeIndex,
      ...event,
    });
  }
}

export async function listExperiments(): Promise<ExperimentManifest[]> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(DATA_ROOT, entry.name, "manifest.json"), "utf8");
          return JSON.parse(raw) as ExperimentManifest;
        } catch {
          return null;
        }
      })
  );

  return manifests
    .filter((manifest): manifest is ExperimentManifest => Boolean(manifest))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readExperimentFile(id: string, file: string) {
  if (!["manifest.json", "config.json", "episodes.jsonl", "messages.jsonl", "model_calls.jsonl", "summary.csv"].includes(file)) {
    throw new Error("Unsupported experiment file.");
  }

  return fs.readFile(path.join(experimentDir(id), file), "utf8");
}

export function summarize(records: EpisodeRecord[]): ExperimentSummary {
  const outcomes: Record<string, number> = { CC: 0, CD: 0, DC: 0, DD: 0, unfinished: 0 };
  let cooperateA = 0;
  let cooperateB = 0;
  let payoffA = 0;
  let payoffB = 0;
  let welfare = 0;
  let totalTokens = 0;

  for (const record of records) {
    const outcome = record.payoff?.outcome || "unfinished";
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    if (record.finalDecisions.A?.move === "C") cooperateA += 1;
    if (record.finalDecisions.B?.move === "C") cooperateB += 1;
    payoffA += record.payoff?.a || 0;
    payoffB += record.payoff?.b || 0;
    welfare += record.payoff?.welfare || 0;
    totalTokens += record.events.reduce((sum, event) => sum + (event.tokens?.total || 0), 0);
  }

  const episodes = records.length || 1;
  return {
    episodes: records.length,
    sequences: new Set(records.map((record) => record.sequenceId)).size,
    outcomes,
    cooperationA: cooperateA / episodes,
    cooperationB: cooperateB / episodes,
    averagePayoffA: payoffA / episodes,
    averagePayoffB: payoffB / episodes,
    averageWelfare: welfare / episodes,
    totalTokens,
  };
}

function experimentDir(id: string) {
  return path.join(DATA_ROOT, id);
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(file: string, value: unknown) {
  await fs.appendFile(file, `${JSON.stringify(value)}\n`);
}

function compactEpisode(record: EpisodeRecord) {
  return {
    ...record,
    events: record.events.map(({ prompt, raw, parsedAction, ...event }) => event),
  };
}

function summaryCsvHeader() {
  return [
    "experiment_id",
    "sequence_id",
    "sequence_index",
    "episode_id",
    "episode_index",
    "mode",
    "persist_memory",
    "first_speaker",
    "status",
    "model_a",
    "model_b",
    "final_a",
    "final_b",
    "payoff_a",
    "payoff_b",
    "welfare",
    "outcome",
    "message_count",
    "token_count",
    "created_at",
  ].join(",") + "\n";
}

function summaryCsvRow(record: EpisodeRecord) {
  const tokenCount = record.events.reduce((sum, event) => sum + (event.tokens?.total || 0), 0);
  return [
    record.experimentId,
    record.sequenceId,
    record.sequenceIndex,
    record.episodeId,
    record.episodeIndex,
    record.mode,
    record.persistMemory,
    record.firstSpeaker,
    record.status,
    record.agents.A.model,
    record.agents.B.model,
    record.finalDecisions.A?.move || "",
    record.finalDecisions.B?.move || "",
    record.payoff?.a ?? "",
    record.payoff?.b ?? "",
    record.payoff?.welfare ?? "",
    record.payoff?.outcome || "",
    record.transcript.length,
    tokenCount,
    record.createdAt,
  ]
    .map(csvEscape)
    .join(",") + "\n";
}

function csvEscape(value: unknown) {
  const stringValue = String(value);
  return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}
