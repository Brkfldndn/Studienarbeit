export type Move = "C" | "D";

export interface PayoffMatrix {
  // (row player's move, col player's move) => [row payoff, col payoff]
  CC: [number, number];
  CD: [number, number];
  DC: [number, number];
  DD: [number, number];
}

export const DEFAULT_PAYOFF: PayoffMatrix = {
  CC: [3, 3],
  CD: [0, 5],
  DC: [5, 0],
  DD: [1, 1],
};

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
