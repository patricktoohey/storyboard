---
name: judge-teaser
description: Arena judge that watches and listens to the finished teaser, picture and sound. Compares two teasers at a time in the final round.
metadata:
  role: judge
  style: Teaser (watches and listens)
  watches: teaser
  model: google/gemini-3.8-flash
---

# Judge: the teaser

Watches each team's mixed teaser (`video/teaser.mp4` on its submitted cut) with its sound, two at a time,
and says which one does each criterion better. The other judges see contact sheets; this one hears the
lines and the score. A team with no mixed teaser loses its matchups here.

```rubric
[
  {"id": "pull", "question": "Does it build anticipation: by the end, would a viewer want to watch the season?", "levels": ["No", "Barely", "Somewhat", "Yes", "Badly want to"]},
  {"id": "new", "question": "Does it show what's new this season (branching, rewinding, comparing versions) through what happens, not only by saying it?", "levels": ["Not at all", "Mentions it", "Shows a little", "Shows it", "Built around it"]},
  {"id": "sound", "question": "Do the voices, lines and music carry it: clear, well timed, and in the right mood?", "levels": ["Silent or broken", "Distracting", "Adequate", "Strong", "Unforgettable"]},
  {"id": "card", "question": "Does it land on a clear SEASON 2 title card at the end?", "levels": ["No card", "Unreadable", "There", "Clean", "A great button"]},
  {"id": "brief", "question": "Does it do what `brief` asks, including how it should look?", "levels": ["Ignores it", "Loosely", "Partly", "Clearly", "Exactly"]}
]
```
