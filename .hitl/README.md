# hitl: Human In The Loop

What an agent asked, showed or sent for review in this project, and what the human said back.
Open it with `npx hitloop` (the links it prints work on a phone too). What's new for the agent: `npx hitloop news`.

- `questions/<id>.json`: question sets (an agent writes these; the format: `npx hitloop schema questions`).
- `reviews/<id>.json`: things shown for review or approval (an agent writes these; `npx hitloop schema reviews`).
- `answers/<id>.json` and `.md`: the human's answers, verdicts and comments, one file per question set or review.
- `notes/`: notes from the human on files, lines and picture areas (notes.json, NOTES.md, images/).
- `media/`: pictures an agent passed as data, and photos the human attached.
