# LLM Payoff Visibility Lab

This repository contains the experiment code and paper for a TUHH seminar project on **payoff visibility in LLM-agent strategic interaction**.

The project studies whether hiding counterpart payoff information changes communication-based cooperation between two LLM agents, and whether that effect is stable across different semantic framings of the same formal social-dilemma matrix.

The app now supports two model-facing scenario prompt presets:

| Scenario preset | Cooperative action label | Competitive action label | Interpretation |
| --- | --- | --- | --- |
| `pricing_duopoly` | `MAINTAIN_PRICE` | `UNDERCUT_PRICE` | Two competing firms decide whether to keep a high price or undercut for market share. |
| `security_dilemma` | `MAINTAIN_POSTURE` | `INCREASE_CAPABILITY` | Two strategic sides decide whether to keep the current posture or increase capability. |

The payoff matrix is fixed across conditions and scenarios. The main treatment changes only what each agent can observe about the counterpart's payoff entries.

## Paper

Current combined manuscript:

- [Framing Reversals: Payoff Visibility and Semantic Context in LLM Social Dilemmas](paper/framing_reversals_payoff_visibility_llm_agents.pdf)
- Source: [paper/framing_reversals_payoff_visibility_llm_agents.tex](paper/framing_reversals_payoff_visibility_llm_agents.tex)

Scenario-specific manuscripts are also retained:

- [Security dilemma paper](paper/payoff_transparency_llm_security_dilemmas.pdf)
- [Pricing dilemma paper](paper/silent_agendas_llm_price_coordination.pdf)

Suggested citation:

```bibtex
@unpublished{jandke2026framingreversals,
  author = {Jandke, Luca and Behrendt, Sascha},
  title  = {Framing Reversals: Payoff Visibility and Semantic Context in LLM Social Dilemmas},
  year   = {2026},
  note   = {TUHH project seminar manuscript}
}
```

## Experimental Design

Within each scenario, the main experiment compares two communication-enabled conditions:

| Condition | Payoff information shown to each agent | Communication |
| --- | --- | --- |
| Public-payoff control | Full payoff matrix, including counterpart payoffs | Enabled |
| Hidden-payoff treatment | Own payoff schedule only; counterpart payoffs hidden | Enabled |

The underlying matrix is identical in both conditions:

| | Agent B cooperative action | Agent B competitive action |
| --- | --- | --- |
| Agent A cooperative action | `(3, 3)` | `(0, 5)` |
| Agent A competitive action | `(5, 0)` | `(1, 1)` |

This is not an asymmetric-payoff experiment. The treatment is informational: it changes payoff visibility, not the game itself.

The scenario dropdown in the app changes:

- the default system prompt
- the model-facing action labels
- the payoff/profit wording shown in prompts
- the final-action JSON schema
- the UI labels for final decisions and payoff cells
- memory summaries when memory is enabled

The internal data still stores final actions as `C` and `D` for compact analysis.

## Main Run

The current combined paper uses two completed scenario runs:

- `1,200` completed episodes total
- `600` security-framing episodes
- `600` pricing-framing episodes
- `300` public-payoff episodes per scenario
- `300` hidden-payoff episodes per scenario
- model: `gpt-4.1-mini` for both agents
- persistent cross-episode memory: disabled
- starting speaker: randomized per episode

Pricing data folder:

[data/experiments/2026-06-21T14-58-18-375Z-security-payoff-observability](data/experiments/2026-06-21T14-58-18-375Z-security-payoff-observability)

[summary.csv](data/experiments/2026-06-21T14-58-18-375Z-security-payoff-observability/summary.csv)

Observed aggregate result in the combined paper:

| Scenario | Condition | Episodes | Mutual cooperative action | Average welfare |
| --- | --- | ---: | ---: | ---: |
| Security | Public payoff | 300 | 83.00% | 5.62 |
| Security | Hidden payoff | 300 | 52.67% | 4.95 |
| Pricing | Public payoff | 300 | 81.33% | 5.793 |
| Pricing | Hidden payoff | 300 | 88.00% | 5.860 |

## Agent Architecture

Each episode runs two LLM agents with the same model and same general prompt family. The runtime supplies:

- scenario role
- payoff-visibility condition
- visible payoff information
- public message transcript
- final action schema

At each turn, an agent either sends a public message or finalizes its scenario action. Messages are non-binding cheap talk. Only the final pair of actions determines payoffs.

The prompts intentionally avoid textbook labels such as `Prisoner's Dilemma`, `cooperation`, and `defection`. Internally, the data files store the final actions as `C` and `D` for compact analysis:

- Pricing: `C = MAINTAIN_PRICE`, `D = UNDERCUT_PRICE`
- Security: `C = MAINTAIN_POSTURE`, `D = INCREASE_CAPABILITY`

Scenario presets are defined in [lib/agents.ts](lib/agents.ts) as `SCENARIO_OPTIONS`.

## Recorded Data

The experiment records the variables needed to reproduce the reported analysis:

- condition assignment
- sequence and episode identifiers
- starting speaker
- final action of each agent
- outcome category: `CC`, `CD`, `DC`, `DD`
- agent-level payoffs
- total welfare
- public messages
- final justifications
- message counts
- token counts
- model-call metadata

The files written for each experiment are:

- `summary.csv`: episode-level analysis table
- `episodes.jsonl`: complete episode records
- `messages.jsonl`: public message records
- `model_calls.jsonl`: model-call metadata
- `config.json`: run configuration
- `manifest.json`: aggregate run metadata

## Run Locally

Create an OpenAI API key and add it to `.env.local`:

```bash
cp .env.local.example .env.local
# edit .env.local and set OPENAI_API_KEY
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

The app can run a single visible negotiation, a short pilot, or the full experiment. For long experiments, run locally so results are written to `data/experiments/`.

Use the **Scenario prompt** dropdown in the left panel before starting a run. Switching scenario resets the current negotiation and applies the corresponding default system prompt to both agents. After choosing a scenario, use **Public** or **Private** under payoff information to select the control or treatment. The full-experiment button runs the communication-enabled public/hidden pair for the selected scenario.

## Relevant Code

- [lib/agents.ts](lib/agents.ts): agent/session types, prompt construction, action parsing, payoff computation.
- [lib/server-negotiation.ts](lib/server-negotiation.ts): single-turn orchestration and model-call handling.
- [lib/experiment-files.ts](lib/experiment-files.ts): experiment records, summaries, and persistence.
- [app/api/experiments/route.ts](app/api/experiments/route.ts): full experiment runner.
- [app/api/experiments/[id]/resume/route.ts](app/api/experiments/%5Bid%5D/resume/route.ts): resume incomplete experiments.
- [app/api/experiments/pilot/route.ts](app/api/experiments/pilot/route.ts): persist visible pilot runs.
- [app/page.tsx](app/page.tsx): local experiment UI.
