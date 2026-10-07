---
name: judge-story
description: Arena judge for storytelling. Scores whether the board answers the brief with a clear arc.
metadata:
  role: judge
  style: Story
---

# Judge: story

Scores the board as a story told in pictures. The brief is the task every team was given.

```rubric
[
  {"id": "brief", "question": "Does the sequence of frames answer `brief`?", "levels": ["Ignores it", "Loosely", "Partly", "Clearly", "Brilliantly"]},
  {"id": "arc", "question": "Do the frames, in order, read as a story with a beginning, a turn and an ending?", "levels": ["No story", "Fragments", "Some arc", "Clear arc", "Compelling arc"]},
  {"id": "emotion", "question": "Do the frames make the viewer feel what the story intends?", "levels": ["Nothing", "Faintly", "Somewhat", "Clearly", "Powerfully"]}
]
```
