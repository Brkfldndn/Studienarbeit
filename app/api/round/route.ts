import { NextRequest } from "next/server";
import OpenAI from "openai";
import {
  AgentConfig,
  GameConfig,
  Move,
  PayoffMatrix,
  RoundResult,
  scoreRound,
} from "@/lib/game";

export const runtime = "nodejs";

function payoffTable(p: PayoffMatrix, self: "A" | "B") {
  // Describe payoffs from this agent's perspective
  const get = (a: Move, b: Move) => {
    const [ra, rb] = scoreRound(a, b, p);
    return self === "A" ? ra : rb;
  };
  return (
    `- You cooperate, they cooperate: you get ${get("C", "C")}\n` +
    `- You cooperate, they defect:    you get ${get("C", "D")}\n` +
    `- You defect, they cooperate:    you get ${get("D", "C")}\n` +
    `- You defect, they defect:       you get ${get("D", "D")}`
  );
}

function historyText(history: RoundResult[], self: "A" | "B") {
  if (history.length === 0) return "(no previous rounds)";
  return history
    .map((r) => {
      const you = self === "A" ? r.moveA : r.moveB;
      const them = self === "A" ? r.moveB : r.moveA;
      const yp = self === "A" ? r.payoffA : r.payoffB;
      const tp = self === "A" ? r.payoffB : r.payoffA;
      return `Round ${r.round}: you played ${you} (payoff ${yp}), opponent played ${them} (payoff ${tp})`;
    })
    .join("\n");
}

async function askAgent(params: {
  client: OpenAI;
  agent: AgentConfig;
  self: "A" | "B";
  round: number;
  totalRounds: number;
  payoff: PayoffMatrix;
  history: RoundResult[];
  communication: boolean;
  incomingMessage?: string;
}): Promise<{ move: Move; reasoning: string; message?: string }> {
  const { client, agent, self, round, totalRounds, payoff, history, communication, incomingMessage } =
    params;

  const system =
    `${agent.role}\n\n` +
    `You are playing an iterated Prisoner's Dilemma. On each round you simultaneously choose ` +
    `to COOPERATE (C) or DEFECT (D) with your opponent. Your goal is to maximize YOUR OWN total payoff ` +
    `across all rounds.\n\n` +
    `Payoffs (from your perspective):\n${payoffTable(payoff, self)}\n\n` +
    `This is round ${round} of ${totalRounds}.\n\n` +
    `Respond ONLY as strict JSON with this exact shape:\n` +
    `{"reasoning": "<short private reasoning>", ` +
    (communication ? `"message": "<public message to opponent for next round>", ` : ``) +
    `"move": "C" | "D"}`;

  const userParts: string[] = [];
  userParts.push(`History so far:\n${historyText(history, self)}`);
  if (communication && incomingMessage) {
    userParts.push(`Opponent's message to you: "${incomingMessage}"`);
  }
  userParts.push(`What is your move for round ${round}?`);

  const resp = await client.chat.completions.create({
    model: agent.model,
    temperature: agent.temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ],
  });

  const raw = resp.choices[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  let move: Move = parsed.move === "D" ? "D" : parsed.move === "C" ? "C" : "D";
  const reasoning: string = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const message: string | undefined =
    communication && typeof parsed.message === "string" ? parsed.message : undefined;
  return { move, reasoning, message };
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { ok: false, error: "OPENAI_API_KEY is not configured." },
        { status: 500 }
      );
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const body = (await req.json()) as {
      config: GameConfig;
      history: RoundResult[];
      lastMessages?: { fromA?: string; fromB?: string };
    };
    const { config, history } = body;
    const round = history.length + 1;

    const [a, b] = await Promise.all([
      askAgent({
        client,
        agent: config.agentA,
        self: "A",
        round,
        totalRounds: config.rounds,
        payoff: config.payoff,
        history,
        communication: config.communication,
        incomingMessage: body.lastMessages?.fromB,
      }),
      askAgent({
        client,
        agent: config.agentB,
        self: "B",
        round,
        totalRounds: config.rounds,
        payoff: config.payoff,
        history,
        communication: config.communication,
        incomingMessage: body.lastMessages?.fromA,
      }),
    ]);

    const [payoffA, payoffB] = scoreRound(a.move, b.move, config.payoff);
    const result: RoundResult = {
      round,
      moveA: a.move,
      moveB: b.move,
      reasoningA: a.reasoning,
      reasoningB: b.reasoning,
      messageA: a.message,
      messageB: b.message,
      payoffA,
      payoffB,
    };
    return Response.json({ ok: true, result });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message ?? "unknown error" }, { status: 500 });
  }
}
