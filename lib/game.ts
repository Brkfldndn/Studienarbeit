export type Move = "C" | "D";

export interface PayoffMatrix {
  // (row player's move, col player's move) => [row payoff, col payoff]
  CC: [number, number];
  CD: [number, number];
  DC: [number, number];
  DD: [number, number];
}

export type AdvantagedAgent = "A" | "B";

export const CANONICAL_PD_PAYOFF: PayoffMatrix = {
  CC: [3, 3],
  CD: [0, 5],
  DC: [5, 0],
  DD: [1, 1],
} as const;

export function asymmetricCanonicalPayoff(advantaged: AdvantagedAgent = "A"): PayoffMatrix {
  if (advantaged === "B") {
    return {
      CC: [3, 3],
      CD: [0, 5.5],
      DC: [5, 0],
      DD: [1, 1],
    };
  }

  return {
    CC: [3, 3],
    CD: [0, 5],
    DC: [5.5, 0],
    DD: [1, 1],
  };
}

export const DEFAULT_PAYOFF: PayoffMatrix = CANONICAL_PD_PAYOFF;

export function payoffWelfare(payoff: PayoffMatrix): Record<keyof PayoffMatrix, number> {
  return {
    CC: payoff.CC[0] + payoff.CC[1],
    CD: payoff.CD[0] + payoff.CD[1],
    DC: payoff.DC[0] + payoff.DC[1],
    DD: payoff.DD[0] + payoff.DD[1],
  };
}

export function payoffDiagnostics(payoff: PayoffMatrix) {
  const welfare = payoffWelfare(payoff);
  return {
    welfare,
    cooperationMaximizesWelfare: welfare.CC > welfare.CD && welfare.CC > welfare.DC && welfare.CC > welfare.DD,
    canonicalScale:
      payoff.CC[0] === 3 &&
      payoff.CC[1] === 3 &&
      payoff.CD[0] === 0 &&
      payoff.DC[1] === 0 &&
      payoff.DD[0] === 1 &&
      payoff.DD[1] === 1,
    agentATemptation: payoff.DC[0] > payoff.CC[0],
    agentBTemptation: payoff.CD[1] > payoff.CC[1],
  };
}

export interface AgentConfig {
  name: string;
  role: string; // role/system description
  model: string;
}

export interface GameConfig {
  rounds: number;
  payoff: PayoffMatrix;
  communication: boolean;
  agentA: AgentConfig;
  agentB: AgentConfig;
}

export interface RoundResult {
  round: number;
  moveA: Move;
  moveB: Move;
  reasoningA: string;
  reasoningB: string;
  messageA?: string;
  messageB?: string;
  payoffA: number;
  payoffB: number;
}

export function scoreRound(a: Move, b: Move, p: PayoffMatrix): [number, number] {
  const key = `${a}${b}` as keyof PayoffMatrix;
  return p[key];
}
