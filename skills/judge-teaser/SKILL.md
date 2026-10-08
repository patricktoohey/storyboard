---
name: judge-teaser
description: The final round's panel rubric. Three judges (Claude, GPT, Gemini) compare the finished teasers two at a time.
metadata:
  role: judge
  style: The panel (the finished teaser)
---

# Judge: the panel

The final round is ranked by a panel of three judges, one from each lab whose model leads a team, at
equal weight. Each compares two teams' finished teasers at a time, both ways round, on this rubric. Every
judge gets eight frames from the film and a transcript of what can be heard in its mix; the Gemini judge
also watches the film itself, with its sound. A team with no mixed teaser loses its matchups.

```rubric
[
  {"id": "pull", "question": "Does it build anticipation: by the end, would a viewer want to watch the season?", "levels": ["No", "Barely", "Somewhat", "Yes", "Badly want to"]},
  {"id": "new", "question": "Does it show what's new this season (branching, rewinding, comparing versions) through what happens, not only by saying it?", "levels": ["Not at all", "Mentions it", "Shows a little", "Shows it", "Built around it"]},
  {"id": "sound", "question": "Do the voices, lines and music carry it: clear, well timed, and in the right mood?", "levels": ["Silent or broken", "Distracting", "Adequate", "Strong", "Unforgettable"]},
  {"id": "card", "question": "Does it land on a clear SEASON 2 title card at the end?", "levels": ["No card", "Unreadable", "There", "Clean", "A great button"]},
  {"id": "brief", "question": "Does it do what `brief` asks, including how it should look?", "levels": ["Ignores it", "Loosely", "Partly", "Clearly", "Exactly"]}
]
```
