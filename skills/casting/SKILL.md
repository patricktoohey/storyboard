---
name: casting
description: Renders one neutral reference portrait per character before any frame is drawn. The portraits anchor identity for medium shots and close-ups and for continuity checks.
---

# Casting

The portrait must show only identity (face, age, hair, wardrobe) so it can be reused in any scene.
The renderer uses the prompt template below; `{{look}}` is replaced with the character's look from the bible.

```prompt
Character reference portrait, head and shoulders, facing camera, neutral expression, plain mid-grey studio background, soft even light, photographic. {{look}}.
```

Keep the background plain and the expression neutral. Anything scene-specific here (rain, a lighthouse,
a smile) leaks into every frame the portrait is used in.
