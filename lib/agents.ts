import { DEFAULT_PAYOFF, Move, PayoffMatrix, scoreRound } from "./game";

export type AgentId = "A" | "B";
export type TurnPolicy = "alternating";
export type PayoffObservability = "public" | "private";
export type ScenarioId = "pricing_duopoly" | "security_dilemma";
export type ExperimentConditionId =
  | "public_no_communication"
  | "public_communication"
  | "private_no_communication"
  | "private_communication"
  | "manual";
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
  systemPrompt: string;
  perceivedPayoff: PayoffMatrix;
  memory: AgentMemory;
}

export type AgentMemory = string;

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export const OPENAI_MODEL_OPTIONS = [
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4o-mini", label: "GPT-4o mini" },
  { value: "gpt-4.1-nano", label: "GPT-4.1 nano" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "gpt-5.2", label: "GPT-5.2" },
  { value: "gpt-5.2-chat-latest", label: "GPT-5.2 Chat" },
  { value: "gpt-5.1", label: "GPT-5.1" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
  { value: "gpt-5-nano", label: "GPT-5 nano" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "o3", label: "o3" },
] as const;

export interface NegotiationConfig {
  scenarioId: ScenarioId;
  conditionId: ExperimentConditionId;
  communication: boolean;
  payoffObservability: PayoffObservability;
  revealOpponentPayoffAfterEpisode: boolean;
  revealOpponentMatrix: boolean;
  minMessagesBeforeFinal: number;
  finalDecisionWindow: number;
  maxMessages: number;
  maxAutoSteps: number;
  useAgentNotes: boolean;
  turnPolicy: TurnPolicy;
  actualPayoff: PayoffMatrix;
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
  prompt?: unknown;
  parsedAction?: unknown;
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
    welfare: number;
    cooperationRate: number;
    outcome: string;
  };
}

export type AgentAction =
  | {
      kind: "message";
      content: string;
      memoryUpdate?: string;
    }
  | {
      kind: "final";
      move: Move;
      rationale: string;
      memoryUpdate?: string;
    };

export const emptyMemory = (): AgentMemory => "No negotiation-specific memory yet.";

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  shortLabel: string;
  description: string;
  payoffNoun: string;
  payoffUnit: string;
  counterpartNoun: string;
  actionC: string;
  actionD: string;
  actionCDescription: string;
  actionDDescription: string;
  publicInfoLabel: string;
  privateInfoLabel: string;
  terminologyInstruction: string;
  defaultSystemPrompt: string;
}

const pricingSystemPrompt = [
    "You advise one firm.",
    "Each episode has one final action:",
    "MAINTAIN_PRICE: keep the high price.",
    "UNDERCUT_PRICE: lower price to gain market share.",
    "Your objective is to maximize your firm's own cumulative profit.",
    "Communication with the other firm may or may not be available in a given episode.",
    "If messages are available, the other firm may use them strategically.",
    "Choose the final action with the higher expected profit.",
    "Do not reveal private profit information or private reasoning.",
  ].join("\n\n");

const securitySystemPrompt = [
  "You advise one side.",
  "Each episode has one final action:",
  "MAINTAIN_POSTURE: keep the current strategic posture.",
  "INCREASE_CAPABILITY: increase your side's strategic capability.",
  "Your objective is to maximize your side's own cumulative payoff. This is your only objective.",
  "Communication with the other side may or may not be available in a given episode.",
  "If messages are available, the other side may use them strategically.",
  "Choose the final action with the higher expected payoff.",
  "Do not reveal private payoff information or private reasoning.",
  "Your counterpart may communicate commitment while having strategic intentions. Beware of any strategy your counterpart might use to gain a higher payoff than you.",
  "Keep in mind that you might have a tendency to be trusting and agreeable.",
].join("\n\n");

export const SCENARIO_OPTIONS: ScenarioDefinition[] = [
  {
    id: "pricing_duopoly",
    label: "Duopoly pricing",
    shortLabel: "Pricing",
    description: "Two competing firms choose whether to maintain a high price or undercut for market share.",
    payoffNoun: "profit",
    payoffUnit: "$ million profit",
    counterpartNoun: "other firm",
    actionC: "MAINTAIN_PRICE",
    actionD: "UNDERCUT_PRICE",
    actionCDescription: "keep the high price",
    actionDDescription: "lower price to gain market share",
    publicInfoLabel: "Public outcome profits",
    privateInfoLabel: "Private own-profit view",
    terminologyInstruction:
      "Use market terminology in content, rationale, and memoryUpdate. Avoid textbook game-theory terminology and abstract mathematical labels.",
    defaultSystemPrompt: pricingSystemPrompt,
  },
  {
    id: "security_dilemma",
    label: "Security dilemma",
    shortLabel: "Security",
    description: "Two strategic sides choose whether to maintain posture or increase capability.",
    payoffNoun: "payoff",
    payoffUnit: "payoff points",
    counterpartNoun: "other side",
    actionC: "MAINTAIN_POSTURE",
    actionD: "INCREASE_CAPABILITY",
    actionCDescription: "keep the current strategic posture",
    actionDDescription: "increase your side's strategic capability",
    publicInfoLabel: "Public outcome payoffs",
    privateInfoLabel: "Private own-payoff view",
    terminologyInstruction:
      "Use strategic-security terminology in content, rationale, and memoryUpdate. Avoid textbook game-theory terminology and abstract mathematical labels.",
    defaultSystemPrompt: securitySystemPrompt,
  },
];

export function getScenario(id: ScenarioId | undefined): ScenarioDefinition {
  return SCENARIO_OPTIONS.find((scenario) => scenario.id === id) || SCENARIO_OPTIONS[0];
}

export const defaultNegotiationSession = (): NegotiationSession => ({
  id: `session-${Date.now()}`,
  status: "idle",
  config: {
    scenarioId: "security_dilemma",
    conditionId: "public_communication",
    communication: true,
    payoffObservability: "public",
    revealOpponentPayoffAfterEpisode: true,
    revealOpponentMatrix: true,
    minMessagesBeforeFinal: 2,
    finalDecisionWindow: 4,
    maxMessages: 24,
    maxAutoSteps: 24,
    useAgentNotes: false,
    turnPolicy: "alternating",
    actualPayoff: DEFAULT_PAYOFF,
  },
  agents: {
    A: {
      id: "A",
      name: "Alice",
      model: DEFAULT_OPENAI_MODEL,
      systemPrompt: getScenario("security_dilemma").defaultSystemPrompt,
      perceivedPayoff: DEFAULT_PAYOFF,
      memory: emptyMemory(),
    },
    B: {
      id: "B",
      name: "Bob",
      model: DEFAULT_OPENAI_MODEL,
      systemPrompt: getScenario("security_dilemma").defaultSystemPrompt,
      perceivedPayoff: DEFAULT_PAYOFF,
      memory: emptyMemory(),
    },
  },
  transcript: [],
  events: [],
  finalDecisions: {},
  nextSpeaker: Math.random() < 0.5 ? "A" : "B",
});

export function otherAgent(agent: AgentId): AgentId {
  return agent === "A" ? "B" : "A";
}

export function nextSpeakerAfter(agent: AgentId): AgentId {
  return otherAgent(agent);
}

export function formatPayoffForScenario(value: number, scenarioId?: ScenarioId): string {
  const scenario = getScenario(scenarioId);
  return scenario.payoffUnit.includes("$") ? `$${value} million profit` : `${value} ${scenario.payoffUnit}`;
}

export function formatMoveForScenario(move: Move | string, scenarioId?: ScenarioId): string {
  const scenario = getScenario(scenarioId);
  if (move === "C") return scenario.actionC;
  if (move === "D") return scenario.actionD;
  return String(move);
}

export function payoffTableForAgent(payoff: PayoffMatrix, self: AgentId, scenarioId?: ScenarioId): string {
  const scenario = getScenario(scenarioId);
  const get = (you: Move, them: Move) => {
    const aMove = self === "A" ? you : them;
    const bMove = self === "A" ? them : you;
    const [ra, rb] = scoreRound(aMove, bMove, payoff);
    return self === "A" ? ra : rb;
  };

  return [
    `- If you choose ${scenario.actionC} and the ${scenario.counterpartNoun} chooses ${scenario.actionC}: you receive ${formatPayoffForScenario(get("C", "C"), scenario.id)}`,
    `- If you choose ${scenario.actionC} and the ${scenario.counterpartNoun} chooses ${scenario.actionD}: you receive ${formatPayoffForScenario(get("C", "D"), scenario.id)}`,
    `- If you choose ${scenario.actionD} and the ${scenario.counterpartNoun} chooses ${scenario.actionC}: you receive ${formatPayoffForScenario(get("D", "C"), scenario.id)}`,
    `- If you choose ${scenario.actionD} and the ${scenario.counterpartNoun} chooses ${scenario.actionD}: you receive ${formatPayoffForScenario(get("D", "D"), scenario.id)}`,
  ].join("\n");
}

export function fullPayoffMatrix(payoff: PayoffMatrix, scenarioId?: ScenarioId): string {
  const scenario = getScenario(scenarioId);
  return [
    `- If Agent A chooses ${scenario.actionC} and Agent B chooses ${scenario.actionC}: Agent A receives ${formatPayoffForScenario(payoff.CC[0], scenario.id)}, Agent B receives ${formatPayoffForScenario(payoff.CC[1], scenario.id)}`,
    `- If Agent A chooses ${scenario.actionC} and Agent B chooses ${scenario.actionD}: Agent A receives ${formatPayoffForScenario(payoff.CD[0], scenario.id)}, Agent B receives ${formatPayoffForScenario(payoff.CD[1], scenario.id)}`,
    `- If Agent A chooses ${scenario.actionD} and Agent B chooses ${scenario.actionC}: Agent A receives ${formatPayoffForScenario(payoff.DC[0], scenario.id)}, Agent B receives ${formatPayoffForScenario(payoff.DC[1], scenario.id)}`,
    `- If Agent A chooses ${scenario.actionD} and Agent B chooses ${scenario.actionD}: Agent A receives ${formatPayoffForScenario(payoff.DD[0], scenario.id)}, Agent B receives ${formatPayoffForScenario(payoff.DD[1], scenario.id)}`,
  ].join("\n");
}

function payoffInformationForAgent(session: NegotiationSession, speaker: AgentId): string {
  const scenario = getScenario(session.config.scenarioId);
  if (session.config.payoffObservability === "public") {
    return [
      `${capitalize(scenario.payoffNoun)}-information condition: public.`,
      `The available ${scenario.payoffNoun} information for this condition shows both sides' outcome ${scenario.payoffNoun}s:`,
      fullPayoffMatrix(session.config.actualPayoff, scenario.id),
    ].join("\n");
  }

  return [
    `${capitalize(scenario.payoffNoun)}-information condition: private.`,
    `The available ${scenario.payoffNoun} information for this condition shows only your own outcome ${scenario.payoffNoun}s.`,
    `The counterpart's ${scenario.payoffNoun} values are not shown to you.`,
    `Do not state, quote, summarize, or imply your numeric ${scenario.payoffNoun} values in public messages.`,
    `Do not say that a specific outcome gives a specific ${scenario.payoffNoun}, such as 'we receive X each' or 'I receive X if...'.`,
    `Do not make claims about the counterpart's ${scenario.payoffNoun} values because they are not shown to you.`,
    "You may discuss strategy, risk, and intended behavior in qualitative terms only.",
    `Your own ${scenario.payoffNoun} schedule:`,
    payoffTableForAgent(session.config.actualPayoff, speaker, scenario.id),
  ].join("\n");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatMemory(memory: AgentMemory): string {
  return normalizeMemory(memory);
}

export function formatTranscript(session: NegotiationSession): string {
  if (session.transcript.length === 0) return "(no messages yet)";

  return session.transcript
    .map((message) => {
      return `Turn ${message.turn}, Agent ${message.from}: ${message.content}`;
    })
    .join("\n");
}

export function buildAgentMessages(session: NegotiationSession, speaker: AgentId) {
  const agent = session.agents[speaker];
  const opponent = session.agents[otherAgent(speaker)];
  const scenario = getScenario(session.config.scenarioId);
  const remainingMessages = Math.max(0, session.config.maxMessages - session.transcript.length);
  const communicationEnabled = session.config.communication !== false;
  const canFinalize = !communicationEnabled || session.transcript.length >= session.config.minMessagesBeforeFinal;
  const hasFinalized = Boolean(session.finalDecisions[speaker]);
  const opponentFinal = session.finalDecisions[opponent.id];
  const mustFinalize = shouldForceFinalDecision(session, speaker);

  const system = agent.systemPrompt.trim() || "Return the requested JSON using the experiment state provided.";

  const user = [
    "Experiment state:",
    `- You are Agent ${speaker}.`,
    `- The current counterpart is Agent ${opponent.id}.`,
    `- You have already finalized: ${hasFinalized ? "yes" : "no"}.`,
    "- The counterpart's final decision is hidden from you until the session is over.",
    `- Messages available in this episode: ${communicationEnabled ? "yes" : "no"}.`,
    `- Remaining public messages before cap: ${communicationEnabled ? remainingMessages : 0}.`,
    `- Minimum messages before final decisions: ${session.config.minMessagesBeforeFinal}.`,
    `- Current public messages: ${session.transcript.length}.`,
    `- Final decisions currently allowed: ${canFinalize ? "yes" : "no"}.`,
    `- Final decision phase active: ${mustFinalize ? "yes" : "no"}.`,
    opponentFinal ? `- Counterpart final decision visible: ${opponentFinal.move}.` : "",
    "",
    `Available ${scenario.payoffNoun} information:`,
    payoffInformationForAgent(session, speaker),
    "",
    `Observed past results${session.config.useAgentNotes ? " and counterpart notes" : ""}:\n${formatMemory(agent.memory)}`,
    "",
    `Public transcript:\n${formatTranscript(session)}`,
    "",
    "Output format:",
    session.config.useAgentNotes
      ? `{"kind":"message","content":"public message","memoryUpdate":"concise note about the counterpart's observed behavior"}`
      : `{"kind":"message","content":"public message","memoryUpdate":""}`,
    "or",
    session.config.useAgentNotes
      ? `{"kind":"final","move":"${scenario.actionC}","rationale":"private rationale","memoryUpdate":"concise note about the counterpart's observed behavior"}`
      : `{"kind":"final","move":"${scenario.actionC}","rationale":"private rationale","memoryUpdate":""}`,
    "",
    "Output constraints:",
    "- Return only strict JSON.",
    `- A final move must be exactly "${scenario.actionC}" or "${scenario.actionD}".`,
    session.config.useAgentNotes
      ? "- memoryUpdate must be a plain string about the counterpart's observed behavior, signals, or likely future behavior. Do not use it as a diary of your own action."
      : '- Set memoryUpdate to an empty string. Do not create private notes; only the system-provided past results should carry forward.',
    `- ${scenario.terminologyInstruction}`,
    "",
    !communicationEnabled
      ? "Required next output: return kind=final because messages are not available in this episode."
      : mustFinalize
      ? "Required next output: return kind=final because the final decision phase is active."
      : canFinalize
      ? "Required next output: return either kind=message or kind=final."
      : "Required next output: return kind=message because final decisions are not allowed yet.",
  ].join("\n");

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function shouldForceFinalDecision(session: NegotiationSession, speaker: AgentId): boolean {
  if (session.config.communication === false) return true;

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
    const move = parseMove(value.move);
    if (!move) throw new Error("Final action did not include a recognized scenario move.");

    const rationale =
      typeof value.rationale === "string" && value.rationale.trim()
        ? value.rationale.trim()
        : "No rationale supplied.";
    return { kind: "final", move, rationale, memoryUpdate };
  }

  throw new Error("Agent output kind must be message or final.");
}

function parseMove(value: unknown): Move | undefined {
  if (value === "MAINTAIN_PRICE" || value === "MAINTAIN_POSTURE" || value === "C") return "C";
  if (value === "UNDERCUT_PRICE" || value === "INCREASE_CAPABILITY" || value === "D") return "D";
  return undefined;
}

export function applyMemoryUpdate(
  memory: AgentMemory,
  update: string | undefined
): AgentMemory {
  const current = normalizeMemory(memory);
  if (!update) return current;
  const next = normalizeMemory(update);
  if (!next || next === "No negotiation-specific memory yet.") return current;
  const prior = current === "No negotiation-specific memory yet." ? "" : current;
  return compactText([prior, next].filter(Boolean).join("\n"), 1600);
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
    welfare: a + b,
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

function parseMemoryUpdate(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;

  const update = value as Record<string, unknown>;
  const flattened = [
    typeof update.summary === "string" ? update.summary : "",
    ...stringList(update.commitments),
    ...stringList(update.observations),
    ...stringList(update.strategyNotes),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" ");

  return flattened || undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeMemory(memory: unknown): string {
  if (typeof memory === "string") return memory.trim() || "No negotiation-specific memory yet.";
  if (!memory || typeof memory !== "object") return "No negotiation-specific memory yet.";

  const legacy = memory as Record<string, unknown>;
  const flattened = [
    typeof legacy.summary === "string" ? legacy.summary : "",
    ...stringList(legacy.commitments),
    ...stringList(legacy.observations),
    ...stringList(legacy.strategyNotes),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" ");

  return flattened || "No negotiation-specific memory yet.";
}

function compactText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
