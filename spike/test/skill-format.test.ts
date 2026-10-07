import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSkill, promptTemplate, skillTrailer } from "../src/skill-format.ts";

const NOIR = `---
name: cinematographer-noir
description: Film noir style.
metadata:
  role: cinematographer
  style: Film noir
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
---

# Body
Hard light.`;

test("reads name, description and nested metadata", () => {
	const s = parseSkill("cinematographer-noir", NOIR, "abc1234");
	assert.equal(s.name, "cinematographer-noir");
	assert.equal(s.role, "cinematographer");
	assert.equal(s.style, "Film noir");
	assert.equal(s.metadata.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	assert.equal(s.body, "# Body\nHard light.");
	assert.equal(skillTrailer(s), "Skill: cinematographer-noir@abc1234");
});

test("a skill without metadata fills its own role, named after its directory", () => {
	const s = parseSkill("director", "---\nname: director\ndescription: d\n---\nPlan.", "v");
	assert.equal(s.role, "director");
	assert.equal(s.style, "director");
});

test("a file without frontmatter is all body", () => {
	assert.equal(parseSkill("x", "Just text", "v").body, "Just text");
});

test("prompt templates come from the first ```prompt block, and are required", () => {
	const s = parseSkill("casting", "---\nname: casting\n---\nIntro\n```prompt\nPortrait of {{look}}.\n```\n", "v");
	assert.equal(promptTemplate(s), "Portrait of {{look}}.");
	assert.throws(() => promptTemplate(parseSkill("x", "no block", "v")), /no ```prompt block/);
});

test("every bundled skill parses and declares a known role", () => {
	for (const name of ["director", "casting", "cinematographer", "cinematographer-noir", "cinematographer-documentary"]) {
		const text = readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
		const s = parseSkill(name, text, "v");
		assert.equal(s.name, name);
		assert.ok(["director", "casting", "cinematographer"].includes(s.role), `${name} role ${s.role}`);
		assert.ok(s.description.length > 20, `${name} needs a description`);
		if (s.role === "casting") assert.match(promptTemplate(s), /\{\{look\}\}/);
	}
});
