# Do Hidden Payoffs Change LLM Cooperation? Evidence from a Duopoly Pricing Dilemma

This repository contains the final seminar paper, experiment code, and archived experiment data for a study of payoff visibility in LLM-agent social dilemmas.

The experiment tests whether two communicating LLM agents behave differently when the counterpart's profit entries are hidden. The setting is a duopoly-pricing dilemma: each agent acts on behalf of a firm, can exchange non-binding messages, and then chooses whether to maintain a high price or undercut.

## Manuscript

- [Final PDF](paper/paper.pdf)
- [LaTeX source](paper/paper.tex)
- [References](paper/references.bib)
- [Agent setup figure](paper/figures/agent_setup_sequence.png)

Suggested citation:

```bibtex
@unpublished{jandke2026hiddenpayoffs,
  author = {Jandke, Luca and Behrendt, Sascha},
  title  = {Do Hidden Payoffs Change LLM Cooperation? Evidence from a Duopoly Pricing Dilemma},
  year   = {2026},
  note   = {TUHH project seminar manuscript}
}
```

## Experimental Design

The primary experiment compares two conditions while holding the payoff matrix, model, communication channel, action space, parser, and scoring rule fixed.

| Condition | Information shown to each agent |
| --- | --- |
| Public-profit control | Full payoff matrix, including rival profits |
| Private-profit treatment | Own profit schedule only; rival profits hidden |

The underlying payoff matrix is identical in both conditions:

| | Firm B maintains price | Firm B undercuts price |
| --- | ---: | ---: |
| Firm A maintains price | `(3, 3)` | `(0, 5)` |
| Firm A undercuts price | `(5, 0)` | `(1, 1)` |

The treatment is therefore informational, not material: both agents face the same game, but they receive different information about the counterpart's incentives.

## Archived Data

The full reported experiment data is included in the repository. Each run directory contains:

- `summary.csv`: episode-level analysis table
- `episodes.jsonl`: complete episode records, including prompts, transcripts, final decisions, and payoffs
- `messages.jsonl`: public message records
- `model_calls.jsonl`: model-call metadata
- `config.json`: run configuration
- `manifest.json`: aggregate run metadata

Primary pricing experiment:

- [Run directory](data/experiments/2026-06-21T14-58-18-375Z-security-payoff-observability)
- [Episode summary](data/experiments/2026-06-21T14-58-18-375Z-security-payoff-observability/summary.csv)

Supplementary scenario-framing check:

- [Run directory](data/experiments/2026-06-30T11-36-17-180Z-security-payoff-observability)
- [Episode summary](data/experiments/2026-06-30T11-36-17-180Z-security-payoff-observability/summary.csv)

The first run directory name is an archive identifier. The recorded system prompt, action labels, transcripts, and final decisions identify it as the primary duopoly-pricing experiment used in the paper.

## Main Results

Primary pricing experiment:

| Condition | Episodes | `CC` | `CD` | `DC` | `DD` | Mutual price maintenance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Public profit | 300 | 244 | 43 | 11 | 2 | 81.33% |
| Private profit | 300 | 264 | 14 | 20 | 2 | 88.00% |

Supplementary security-framing check:

| Condition | Episodes | `CC` | `CD` | `DC` | `DD` | Mutual cooperative action |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Public payoff | 300 | 216 | 65 | 7 | 12 | 72.00% |
| Private payoff | 300 | 236 | 15 | 30 | 19 | 78.67% |

In the primary pricing experiment, hiding counterpart profit entries increases mutual price maintenance by 6.67 percentage points.

## Reproducing the App

Create an OpenAI API key and add it to `.env.local`:

```bash
cp .env.local.example .env.local
# edit .env.local and set OPENAI_API_KEY
npm install
npm run dev
```

Open the local app at:

```text
http://localhost:3000
```

The app can run a visible single negotiation, a short pilot, or a full experiment. Long runs should be executed locally so result files are written to `data/experiments/`.

## Code Structure

- [lib/agents.ts](lib/agents.ts): agent/session types, prompt construction, action parsing, payoff computation
- [lib/server-negotiation.ts](lib/server-negotiation.ts): single-turn orchestration and model-call handling
- [lib/experiment-files.ts](lib/experiment-files.ts): experiment records, summaries, and persistence
- [app/api/experiments/route.ts](app/api/experiments/route.ts): full experiment runner
- [app/api/experiments/[id]/resume/route.ts](app/api/experiments/%5Bid%5D/resume/route.ts): resume incomplete experiments
- [app/api/experiments/pilot/route.ts](app/api/experiments/pilot/route.ts): persist visible pilot runs
- [app/page.tsx](app/page.tsx): local experiment UI
