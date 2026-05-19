# LLM Negotiation Lab

Next.js app for running two LLM agents through a controlled negotiation before
they submit final Prisoner's Dilemma decisions.

## Features
- Two independent LLM agents (A / B), each with its own model, temperature,
  system prompt, private information, and private memory.
- Arbitrary-length negotiation transcript bounded by configurable message and
  auto-step caps.
- Stepwise orchestration: each `/api/negotiate` call asks one agent to either
  send a public message or submit a final C/D decision.
- Agent memory is explicit state: summaries, commitments, observations, and
  strategy notes are updated after each model call.
- Localhost observatory UI with live transcript, final decisions, payoff matrix,
  token accounting, and expandable raw event trace.

## Setup
1. `cp .env.local.example .env.local` and set `OPENAI_API_KEY`.
2. `npm install`
3. `npm run dev`
4. Open http://localhost:3000

## Architecture
- `lib/agents.ts` contains the negotiation session types, agent memory model,
  prompt construction, JSON action parsing, and payoff computation.
- `app/api/negotiate/route.ts` runs one agent turn through the OpenAI API.
- `app/page.tsx` controls and visualizes the experiment from localhost.
- `lib/game.ts` keeps the payoff matrix and round-scoring primitives.

The experiment runtime owns turn order, caps, validation, final scoring, and the
event log. The agents own only their private prompts, private information,
memory, and next action.
