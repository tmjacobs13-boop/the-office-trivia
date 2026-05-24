# The Office Trivia

Two-player real-time trivia game themed on *The Office* (US). Pick a difficulty tier (1–10), answer faster than your opponent for a speed bonus, first to 500 points wins.

## How it works

- Player A creates a room, gets a 4-letter code, shares it with Player B
- Each round, the "chooser" picks a tier (1 = easiest, 10 = hardest)
  - Tier N is worth `N × 10` points
- Both players see the same multiple-choice question, lock in secretly
- Correct answer → tier points. First correct lock-in → `+5` speed bonus
- Roles swap each round. First to 500 wins.

## Local dev

```bash
npm install
npm start
# open http://localhost:3000 in two tabs
```

## Deploy on Render

This repo includes `render.yaml`. In the Render dashboard:

1. **New +** → **Blueprint**
2. Connect this GitHub repo
3. Render reads `render.yaml`, provisions a free web service
4. Wait ~2 minutes for the first build
5. Share the `*.onrender.com` URL

The free tier spins down after 15 minutes of inactivity (cold start ~30s on first hit).

## Adding questions

`questions.json` is keyed by tier (`tier1` … `tier10`). Each entry:

```json
{ "id": "t3-042", "q": "Question text?", "choices": ["A","B","C","D"], "correct": 2 }
```

`correct` is the zero-based index into `choices`.
