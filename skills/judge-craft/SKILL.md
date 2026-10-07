---
name: judge-craft
description: Arena judge for visual craft. Scores the printed frames of a team's board for consistency, framing and image quality.
metadata:
  role: judge
  style: Craft
---

# Judge: craft

Scores what is on screen. The frames are shown in shot order; text from the team (beats) is context only.

```rubric
[
  {"id": "continuity", "question": "Do the same characters look the same (face, age, hair, wardrobe) in every frame where they appear?", "levels": ["Different people", "Often inconsistent", "Mostly consistent", "Consistent", "Flawless"]},
  {"id": "framing", "question": "Do the frames use varied, purposeful framing (wide to close) that suits each moment?", "levels": ["Monotonous or random", "Weak", "Adequate", "Good", "Masterful"]},
  {"id": "image", "question": "Are the frames free of generation defects (warped faces, extra limbs, garbled objects, objects that don't belong)?", "levels": ["Badly broken", "Visible defects", "Minor defects", "Clean", "Pristine"]}
]
```
