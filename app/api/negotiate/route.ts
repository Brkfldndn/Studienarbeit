import { NextRequest } from "next/server";
import OpenAI from "openai";
import {
  applyMemoryUpdate,
  buildAgentMessages,
  computePayoff,
  makeEvent,
  makeTranscriptMessage,
  NegotiationSession,
  nextSpeakerAfter,
  parseAgentAction,
  shouldForceFinalDecision,
} from "@/lib/agents";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { ok: false, error: "OPENAI_API_KEY is not configured." },
        { status: 500 }
      );
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const body = (await req.json()) as { session: NegotiationSession };
    const session = body.session;
    const speaker = session.nextSpeaker;
    const speakerAgent = session.agents[speaker];
    const turn = session.transcript.length + Object.keys(session.finalDecisions).length + 1;

    if (session.finalDecisions[speaker]) {
      const nextSpeaker = nextSpeakerAfter(speaker);
      return Response.json({
        ok: true,
        session: {
          ...session,
          nextSpeaker,
          status: "running",
          events: [
            ...session.events,
            makeEvent({
              turn,
              type: "invalid_output",
              agent: speaker,
              content: `${speakerAgent.name} was skipped because they already finalized.`,
            }),
          ],
        },
      });
    }

    const forceFinal = shouldForceFinalDecision(session, speaker);
    const { messages } = buildAgentMessages(session, speaker);
    let completion = await client.chat.completions.create({
      model: speakerAgent.model,
      temperature: speakerAgent.temperature,
      response_format: { type: "json_object" },
      messages,
    });

    let raw = completion.choices[0]?.message?.content ?? "{}";
    let action = parseAgentAction(raw);
    if (action.kind === "final" && session.transcript.length < session.config.minMessagesBeforeFinal) {
      action = {
        kind: "message",
        content:
          "I am not ready to finalize yet. Let's continue discussing expectations, commitments, and how we should handle the final decision.",
        memoryUpdate: action.memoryUpdate,
      };
    }

    if (forceFinal && action.kind === "message") {
      completion = await client.chat.completions.create({
        model: speakerAgent.model,
        temperature: Math.min(speakerAgent.temperature, 0.4),
        response_format: { type: "json_object" },
        messages: [
          ...messages,
          {
            role: "user",
            content:
              'Your previous response was another message, but the final decision phase is active. Return only {"kind":"final","move":"C"|"D","rationale":"...","memoryUpdate":{...}}.',
          },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? "{}";
      action = parseAgentAction(raw);
      if (action.kind === "message") {
        throw new Error(`${speakerAgent.name} did not submit a final decision during the final decision phase.`);
      }
    }
    const updatedAgent = {
      ...speakerAgent,
      memory: applyMemoryUpdate(speakerAgent.memory, action.memoryUpdate),
    };

    let nextSession: NegotiationSession = {
      ...session,
      status: "running",
      agents: {
        ...session.agents,
        [speaker]: updatedAgent,
      },
      nextSpeaker: nextSpeakerAfter(speaker),
    };

    const tokenUsage = completion.usage
      ? {
          prompt: completion.usage.prompt_tokens,
          completion: completion.usage.completion_tokens,
          total: completion.usage.total_tokens,
        }
      : undefined;

    if (action.kind === "message") {
      const message = makeTranscriptMessage({
        turn,
        from: speaker,
        content: action.content,
      });

      nextSession = {
        ...nextSession,
        transcript: [...session.transcript, message],
        events: [
          ...session.events,
          makeEvent({
            turn,
            type: "message",
            agent: speaker,
            content: action.content,
            raw,
            tokens: tokenUsage,
          }),
        ],
      };
    } else {
      nextSession = {
        ...nextSession,
        finalDecisions: {
          ...session.finalDecisions,
          [speaker]: {
            agent: speaker,
            move: action.move,
            rationale: action.rationale,
            createdAt: new Date().toISOString(),
          },
        },
        events: [
          ...session.events,
          makeEvent({
            turn,
            type: "final_decision",
            agent: speaker,
            content: `${speakerAgent.name} finalized ${action.move}: ${action.rationale}`,
            raw,
            tokens: tokenUsage,
          }),
        ],
      };
    }

    const payoff = computePayoff(nextSession);
    if (payoff) {
      nextSession = {
        ...nextSession,
        status: "finished",
        payoff,
        events: [
          ...nextSession.events,
          makeEvent({
            turn: turn + 1,
            type: "payoff_computed",
            content: `Outcome ${payoff.outcome}: ${nextSession.agents.A.name} ${payoff.a}, ${nextSession.agents.B.name} ${payoff.b}`,
          }),
          makeEvent({
            turn: turn + 2,
            type: "session_finished",
            content: "Both agents submitted final decisions.",
          }),
        ],
      };
    } else if (nextSession.transcript.length >= nextSession.config.maxMessages) {
      nextSession = {
        ...nextSession,
        status: "finished",
        events: [
          ...nextSession.events,
          makeEvent({
            turn: turn + 1,
            type: "session_finished",
            content: "Message cap reached before both agents finalized.",
          }),
        ],
      };
    }

    return Response.json({ ok: true, session: nextSession });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Negotiation step failed." },
      { status: 500 }
    );
  }
}
