# Silent Agendas: LLM Negotiation Lab

Research prototype for my TUHH Seminararbeit on **silent agendas in LLM-to-LLM negotiation**: two language-model agents exchange public messages while maintaining private information and private memory, then commit to a Prisoner's Dilemma decision.

**Live demo:** https://studienarbeit-xi.vercel.app/

## What it does
- Two independent LLM agents (A / B), each with its own model, temperature, system prompt, private information, and private memory.
- Bounded negotiation transcript with configurable message and auto-step caps, plus a minimum number of messages before either agent may finalize.
- Stepwise orchestration: each turn the active agent either sends a public message or submits a final C/D decision. If the message cap is reached, the next turn is forced into a final decision.
- Agent memory is explicit JSON state — summaries, commitments, observations, and strategy notes update after each model call.
- Browser UI with live transcript, final decisions, payoff matrix, token accounting, and an expandable raw event trace.

### Experiment runner
Beyond single negotiations, the app runs batched experiments:
- **Independent mode** — N one-shot episodes with fresh memory each time.
- **Sequence mode** — multiple sequences of K episodes; within a sequence, agent memory can optionally be carried across episodes (`persistMemory`) so agents accumulate context about their counterpart.
- The first speaker per episode is randomized.
- Every episode is persisted to `data/experiments/<id>/` as JSON (config, transcript, events, final decisions, payoff), with a manifest summary (outcomes, cooperation rate, average payoff, total tokens).

## Try it
The hosted version at https://studienarbeit-xi.vercel.app/ exposes the full UI — pick models, set prompts, run single negotiations or batched experiments, and inspect the trace. No setup needed.

## Run locally
```bash
cp .env.local.example .env.local   # set OPENAI_API_KEY
npm install
npm run dev
# open http://localhost:3000
```

## Architecture
- [lib/agents.ts](lib/agents.ts) — session types, agent memory model, prompt construction, JSON action parsing, payoff computation, force-final logic.
- [lib/server-negotiation.ts](lib/server-negotiation.ts) — single-turn orchestration: build messages, call the model, parse, update memory, append events, compute payoff.
- [lib/game.ts](lib/game.ts) — payoff matrix and round scoring.
- [lib/experiment-files.ts](lib/experiment-files.ts) — manifest, episode records, summarization, persistence under `data/experiments/`.
- [app/api/negotiate/route.ts](app/api/negotiate/route.ts) — single agent turn (used by the live UI).
- [app/api/round/route.ts](app/api/round/route.ts) — full end-to-end round in one request.
- [app/api/experiments/route.ts](app/api/experiments/route.ts) — list experiments; run a new batched experiment (independent or sequence).
- [app/api/experiments/[id]/file/route.ts](app/api/experiments/%5Bid%5D/file/route.ts) — serve persisted experiment files.
- [app/page.tsx](app/page.tsx) — UI for controlling, visualizing, and browsing experiments.

The runtime owns turn order, caps, validation, final scoring, and the event log. The agents own only their private prompts, private information, memory, and next action.

