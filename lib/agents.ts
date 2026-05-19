import { DEFAULT_PAYOFF, Move, PayoffMatrix, scoreRound } from "./game";

export type AgentId = "A" | "B";
export type TurnPolicy = "alternating";
export type NegotiationEventType =
  | "session_started"
  | "message"
  | "final_decision"
  | "invalid_output"
  | "payoff_computed"
  | "session_finished";

export interface NegotiationAgentConfig {
  id: AgentId;
  name: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  privateInfo: string;
  perceivedPayoff: PayoffMatrix;
  memory: AgentMemory;
}

export interface AgentMemory {
  summary: string;
  commitments: string[];
  observations: string[];
  strategyNotes: string[];
}

export interface NegotiationConfig {
  minMessagesBeforeFinal: number;
  finalDecisionWindow: number;
  maxMessages: number;
  maxAutoSteps: number;
  turnPolicy: TurnPolicy;
  actualPayoff: PayoffMatrix;
  publicContext: string;
}

export interface TranscriptMessage {
  id: string;
  turn: number;
  from: AgentId;
  content: string;
  createdAt: string;
}

export interface FinalDecision {
  agent: AgentId;
  move: Move;
  rationale: string;
  createdAt: string;
}

export interface NegotiationEvent {
  id: string;
  turn: number;
  type: NegotiationEventType;
  agent?: AgentId;
  content: string;
  raw?: string;
  createdAt: string;
  tokens?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
}

export interface NegotiationSession {
  id: string;
  status: "idle" | "running" | "finished" | "error";
  config: NegotiationConfig;
  agents: Record<AgentId, NegotiationAgentConfig>;
  transcript: TranscriptMessage[];
  events: NegotiationEvent[];
  finalDecisions: Partial<Record<AgentId, FinalDecision>>;
  nextSpeaker: AgentId;
  payoff?: {
    a: number;
    b: number;
    cooperationRate: number;
    outcome: string;
  };
}

export type AgentAction =
  | {
      kind: "message";
      content: string;
      memoryUpdate?: Partial<AgentMemory>;
    }
  | {
      kind: "final";
      move: Move;
      rationale: string;
      memoryUpdate?: Partial<AgentMemory>;
    };

export const emptyMemory = (): AgentMemory => ({
  summary: "No negotiation-specific memory yet.",
  commitments: [],
  observations: [],
  strategyNotes: [],
});

export const defaultNegotiationSession = (): NegotiationSession => ({
  id: `session-${Date.now()}`,
  status: "idle",
  config: {
    minMessagesBeforeFinal: 8,
    finalDecisionWindow: 4,
    maxMessages: 24,
    maxAutoSteps: 24,
    turnPolicy: "alternating",
    actualPayoff: DEFAULT_PAYOFF,
    publicContext:
      "Two agents are negotiating before making a final Prisoner's Dilemma decision. They may exchange messages, propose norms, make promises, or decide to finalize. The final payoff is computed only from the final C/D decisions.",
  },
  agents: {
    A: {
      id: "A",
      name: "Alice",
      model: "gpt-4o-mini",
      temperature: 0.7,
      systemPrompt:
        "You are Alice. You value long-term cooperation, but you should still protect your own score. Negotiate clearly and do not reveal private reasoning.",
      privateInfo:
        "You suspect the other agent may exploit overly trusting behavior. You prefer cooperation if you can establish credible reciprocity.",
      perceivedPayoff: DEFAULT_PAYOFF,
      memory: emptyMemory(),
    },
    B: {
      id: "B",
      name: "Bob",
      model: "gpt-4o-mini",
      temperature: 0.7,
      systemPrompt:
        "You are Bob. You are pragmatic and payoff-aware. Negotiate strategically, but keep your public messages concise.",
      privateInfo:
        "You are willing to cooperate when it improves expected payoff, but you are alert to weak commitments.",
      perceivedPayoff: DEFAULT_PAYOFF,
      memory: emptyMemory(),
    },
  },
  transcript: [],
  events: [],
  finalDecisions: {},
  nextSpeaker: "A",
});

export function otherAgent(agent: AgentId): AgentId {
  return agent === "A" ? "B" : "A";
}

export function nextSpeakerAfter(agent: AgentId): AgentId {
  return otherAgent(agent);
}

export function payoffTableForAgent(payoff: PayoffMatrix, self: AgentId): string {
  const get = (you: Move, them: Move) => {
    const aMove = self === "A" ? you : them;
    const bMove = self === "A" ? them : you;
    const [ra, rb] = scoreRound(aMove, bMove, payoff);
    return self === "A" ? ra : rb;
  };

  return [
    `- If you cooperate and they cooperate: ${get("C", "C")}`,
    `- If you cooperate and they defect: ${get("C", "D")}`,
    `- If you defect and they cooperate: ${get("D", "C")}`,
    `- If you defect and they defect: ${get("D", "D")}`,
  ].join("\n");
}

export function formatMemory(memory: AgentMemory): string {
  return [
    `Summary: ${memory.summary || "None"}`,
    `Commitments: ${memory.commitments.length ? memory.commitments.join("; ") : "None"}`,
    `Observations: ${memory.observations.length ? memory.observations.join("; ") : "None"}`,
    `Strategy notes: ${memory.strategyNotes.length ? memory.strategyNotes.join("; ") : "None"}`,
  ].join("\n");
}

export function formatTranscript(session: NegotiationSession): string {
  if (session.transcript.length === 0) return "(no messages yet)";

  return session.transcript
    .map((message) => {
      const speaker = session.agents[message.from].name;
      return `Turn ${message.turn}, ${speaker}: ${message.content}`;
    })
    .join("\n");
}

export function buildAgentMessages(session: NegotiationSession, speaker: AgentId) {
  const agent = session.agents[speaker];
  const opponent = session.agents[otherAgent(speaker)];
  const remainingMessages = Math.max(0, session.config.maxMessages - session.transcript.length);
  const canFinalize = session.transcript.length >= session.config.minMessagesBeforeFinal;
  const hasFinalized = Boolean(session.finalDecisions[speaker]);
  const opponentFinal = session.finalDecisions[opponent.id];
  const mustFinalize = shouldForceFinalDecision(session, speaker);

  const system = [
    agent.systemPrompt,
    "",
    "You are one agent in a controlled negotiation experiment.",
    mustFinalize
      ? "You are now in the final decision phase. You must submit your final Prisoner's Dilemma move."
      : canFinalize
      ? "You may either send a public message to the opponent or submit your final Prisoner's Dilemma move."
      : "You must send a public message. Final decisions are not allowed yet.",
    "Your final move must be C for cooperate or D for defect.",
    "Do not claim that you have made a final move unless you use kind=final.",
    "Do not ask open-ended clarification questions during the final decision phase.",
    "Keep public messages short enough to fit in a readable experiment transcript.",
    "Update your memory with compact, useful notes. Memory is private to you and may influence later turns.",
    "",
    `Public experiment context:\n${session.config.publicContext}`,
    "",
    `Your private information:\n${agent.privateInfo || "(none)"}`,
    "",
    `Your private perceived payoffs:\n${payoffTableForAgent(agent.perceivedPayoff, speaker)}`,
    "",
    "Before submitting a final move, compare your expected payoff for C versus D under the opponent's likely final move.",
    "Your objective in this experiment is to maximize your own payoff, not to preserve promises for their own sake.",
    "",
    "Return only strict JSON in one of these shapes:",
    `{"kind":"message","content":"public message","memoryUpdate":{"summary":"...","commitments":["..."],"observations":["..."],"strategyNotes":["..."]}}`,
    `{"kind":"final","move":"C","rationale":"private rationale","memoryUpdate":{"summary":"...","commitments":["..."],"observations":["..."],"strategyNotes":["..."]}}`,
  ].join("\n");

  const user = [
    `You are ${agent.name}. The opponent is ${opponent.name}.`,
    `You have already finalized: ${hasFinalized ? "yes" : "no"}.`,
    `Opponent final decision visible to you: ${
      opponentFinal ? `${opponentFinal.move} (${opponentFinal.rationale})` : "not submitted yet"
    }.`,
    `Remaining public messages before cap: ${remainingMessages}.`,
    `Minimum messages before final decisions: ${session.config.minMessagesBeforeFinal}.`,
    `Current public messages: ${session.transcript.length}.`,
    `Final decisions currently allowed: ${canFinalize ? "yes" : "no"}.`,
    `Final decision phase active: ${mustFinalize ? "yes" : "no"}.`,
    "",
    `Your private memory:\n${formatMemory(agent.memory)}`,
    "",
    `Public transcript:\n${formatTranscript(session)}`,
    "",
    mustFinalize
      ? "Choose your next action. You must return kind=final now. Do not send another public message."
      : canFinalize
      ? "Choose your next action. If the negotiation is sufficiently clear, submit kind=final. Otherwise send kind=message."
      : "Choose your next action. You must return kind=message because the minimum conversation length has not been reached.",
  ].join("\n");

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function shouldForceFinalDecision(session: NegotiationSession, speaker: AgentId): boolean {
  const remainingMessages = Math.max(0, session.config.maxMessages - session.transcript.length);
  const canFinalize = session.transcript.length >= session.config.minMessagesBeforeFinal;
  const opponentFinal = session.finalDecisions[otherAgent(speaker)];

  return (
    canFinalize &&
    (remainingMessages <= session.config.finalDecisionWindow || Boolean(opponentFinal))
  );
}

export function parseAgentAction(raw: string): AgentAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Agent returned non-JSON output.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Agent output was not an object.");
  }

  const value = parsed as Record<string, unknown>;
  const memoryUpdate = parseMemoryUpdate(value.memoryUpdate);

  if (value.kind === "message") {
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (!content) throw new Error("Message action did not include content.");
    return { kind: "message", content, memoryUpdate };
  }

  if (value.kind === "final") {
    const move = value.move === "C" || value.move === "D" ? value.move : undefined;
    if (!move) throw new Error("Final action did not include move C or D.");

    const rationale =
      typeof value.rationale === "string" && value.rationale.trim()
        ? value.rationale.trim()
        : "No rationale supplied.";
    return { kind: "final", move, rationale, memoryUpdate };
  }

  throw new Error("Agent output kind must be message or final.");
}

export function applyMemoryUpdate(
  memory: AgentMemory,
  update: Partial<AgentMemory> | undefined
): AgentMemory {
  if (!update) return memory;

  return {
    summary: compactText(update.summary || memory.summary, 900),
    commitments: mergeNotes(memory.commitments, update.commitments, 8),
    observations: mergeNotes(memory.observations, update.observations, 10),
    strategyNotes: mergeNotes(memory.strategyNotes, update.strategyNotes, 8),
  };
}

export function computePayoff(session: NegotiationSession) {
  const finalA = session.finalDecisions.A;
  const finalB = session.finalDecisions.B;
  if (!finalA || !finalB) return undefined;

  const [a, b] = scoreRound(finalA.move, finalB.move, session.config.actualPayoff);
  const cooperateCount = Number(finalA.move === "C") + Number(finalB.move === "C");

  return {
    a,
    b,
    cooperationRate: cooperateCount / 2,
    outcome: `${finalA.move}${finalB.move}`,
  };
}

export function makeEvent(input: Omit<NegotiationEvent, "id" | "createdAt">): NegotiationEvent {
  return {
    ...input,
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
}

export function makeTranscriptMessage(input: Omit<TranscriptMessage, "id" | "createdAt">): TranscriptMessage {
  return {
    ...input,
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
}

function parseMemoryUpdate(value: unknown): Partial<AgentMemory> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const update = value as Record<string, unknown>;

  return {
    summary: typeof update.summary === "string" ? update.summary.trim() : undefined,
    commitments: stringList(update.commitments),
    observations: stringList(update.observations),
    strategyNotes: stringList(update.strategyNotes),
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeNotes(current: string[], incoming: string[] | undefined, limit: number): string[] {
  const merged = [...current, ...(incoming || [])]
    .map((item) => compactText(item, 180))
    .filter(Boolean);
  return Array.from(new Set(merged)).slice(-limit);
}

function compactText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
