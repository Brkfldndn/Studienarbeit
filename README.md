# Prisoner's Dilemma — LLM Replication (Flood, 1958)

Next.js app that replicates the iterated Prisoner's Dilemma using two LLM agents
via the OpenAI API. Based on the task description in
`Aufgabenbeschreibung_Prisoners Dilemma 2.pdf`.

## Features
- Two independent LLM agents (A / B), each with its own role prompt,
  temperature, and model.
- Configurable payoff matrix, number of rounds, and optional
  inter-agent communication channel.
- Split-screen UI: left 20vw shows Agent A simulation, middle shows
  leaderboard / round history / game config, right 30vw shows Agent B.
- API route `/api/round` orchestrates one simultaneous round by asking
  each agent for a JSON-formatted move, reasoning, and optional message.

## Setup
1. `cp .env.local.example .env.local` and set `OPENAI_API_KEY`.
2. `npm install`
3. `npm run dev`
4. Open http://localhost:3000

## Research directions (from the task PDF)
- Vary payoff structure, communication availability, role prompts,
  and temperature to study cooperation behavior.
- Compare stability vs variability of strategies across conditions.
