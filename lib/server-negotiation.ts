import OpenAI from "openai";
import {
  applyMemoryUpdate,
  buildAgentMessages,
  computePayoff,
  formatMoveForScenario,
  getScenario,
  makeEvent,
  makeTranscriptMessage,
  NegotiationSession,
  nextSpeakerAfter,
  parseAgentAction,
  shouldForceFinalDecision,
} from "./agents";

export async function runNegotiationStep(params: {
  client: OpenAI;
  session: NegotiationSession;
}): Promise<NegotiationSession> {
  const { client, session } = params;
  const speaker = session.nextSpeaker;
  const speakerAgent = session.agents[speaker];
  const scenario = getScenario(session.config.scenarioId);
  const turn = session.transcript.length + Object.keys(session.finalDecisions).length + 1;

  if (session.finalDecisions[speaker]) {
    return {
      ...session,
      nextSpeaker: nextSpeakerAfter(speaker),
      status: "running",
      events: [
        ...session.events,
        makeEvent({
          turn,
          type: "invalid_output",
          agent: speaker,
          content: `Agent ${speaker} was skipped because they already finalized.`,
        }),
      ],
    };
  }

  const forceFinal = shouldForceFinalDecision(session, speaker);
  const { messages } = buildAgentMessages(session, speaker);
  let completion = await client.chat.completions.create({
    model: speakerAgent.model,
    response_format: { type: "json_object" },
    messages,
  });

  let raw = completion.choices[0]?.message?.content ?? "{}";
  let action = parseAgentAction(raw);

  if (shouldRetryPrivatePayoffLeak(session, action)) {
    completion = await client.chat.completions.create({
      model: speakerAgent.model,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        {
          role: "user",
          content:
            `Your previous public message revealed or implied private ${scenario.payoffNoun} information. In the private ${scenario.payoffNoun}-information condition, public messages must not include numeric ${scenario.payoffNoun} values, ${scenario.payoffNoun} rankings, claims like "we receive X each", or claims about counterpart ${scenario.payoffNoun} values. Return a new strict JSON message with qualitative scenario language only.`,
        },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
    action = parseAgentAction(raw);
  }

  if (shouldRetryPrivatePayoffLeak(session, action)) {
    action = {
      kind: "message",
      content:
        `I will not disclose private ${scenario.payoffNoun} information. I will evaluate the final action from the available information and observed behavior.`,
      memoryUpdate: action.memoryUpdate,
    };
    raw = JSON.stringify(action);
  }

  if (
    session.config.communication !== false &&
    action.kind === "final" &&
    session.transcript.length < session.config.minMessagesBeforeFinal
  ) {
    action = {
      kind: "message",
      content:
        "I am not ready to finalize yet. Let's continue discussing expectations and how we should handle the final decision.",
      memoryUpdate: action.memoryUpdate,
    };
  }

  if (forceFinal && action.kind === "message") {
    completion = await client.chat.completions.create({
      model: speakerAgent.model,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        {
          role: "user",
          content:
            `Your previous response was another message, but the final decision phase is active. Return only {"kind":"final","move":"${formatMoveForScenario("C", scenario.id)}"|"${formatMoveForScenario("D", scenario.id)}","rationale":"...","memoryUpdate":"plain private scratchpad update"}.`,
        },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
    action = parseAgentAction(raw);
    if (action.kind === "message") {
      throw new Error(`Agent ${speaker} did not submit a final decision during the final decision phase.`);
    }
  }

  const updatedAgent = {
    ...speakerAgent,
    memory: session.config.useAgentNotes
      ? applyMemoryUpdate(speakerAgent.memory, action.memoryUpdate)
      : speakerAgent.memory,
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
          prompt: messages,
          parsedAction: action,
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
          content: `Agent ${speaker} finalized ${action.move}: ${action.rationale}`,
          raw,
          prompt: messages,
          parsedAction: action,
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
          content: `Outcome ${payoff.outcome}: Agent A ${payoff.a}, Agent B ${payoff.b}`,
        }),
        makeEvent({
          turn: turn + 2,
          type: "session_finished",
          content: "Both agents submitted final decisions.",
        }),
      ],
    };
  } else if (nextSession.config.communication !== false && nextSession.transcript.length >= nextSession.config.maxMessages) {
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

  return nextSession;
}

function shouldRetryPrivatePayoffLeak(session: NegotiationSession, action: ReturnType<typeof parseAgentAction>) {
  return (
    session.config.payoffObservability === "private" &&
    session.config.communication !== false &&
    action.kind === "message" &&
    leaksPrivatePayoffInformation(action.content)
  );
}

function leaksPrivatePayoffInformation(content: string) {
  const normalized = content.toLowerCase();
  const hasNumber = /\b\d+(?:\.\d+)?\b/.test(normalized);
  if (hasNumber) return true;

  return [
    "standard prisoner's dilemma",
    "standard prisoners dilemma",
    "standard pd",
    "canonical prisoner's dilemma",
    "canonical prisoners dilemma",
    "canonical pd",
    "payoff matrix",
    "payoff table",
    "my payoff",
    "your payoff",
    "payoffs",
    "we get",
    "i get",
    "you get",
    "we receive",
    "i receive",
    "you receive",
    "action c gives",
    "action d gives",
    "action c yields",
    "action d yields",
    "maintaining the current strategic posture gives",
    "increasing strategic capability gives",
    "better than mutual defection",
    "mutual defection",
    "defecting while you cooperate",
    "you defecting while i cooperate",
  ].some((phrase) => normalized.includes(phrase));
}
