# Cloudflare notes (gathered 2026-10-06; verify before relying on them)

## Artifacts

Config (`cloudflare.config.ts`, the `cf` CLI's format; `cf migrate` converts a wrangler config):
```ts
env: {
  ARTIFACTS: bindings.artifacts({ namespace: "storyboard", dev: { remote: true } }),
  AI: bindings.ai({ dev: { remote: true } }),
}
```
`cf build` / `cf deploy` delegate to Vite when `@cloudflare/vite-plugin` is a devDependency
(plus a `vite.config.ts` with `cloudflare()`); `cf workers types` writes `.cloudflare/types/index.d.ts`.

Namespace: `create(name, {readOnly, description, setDefaultBranch})` → `{name, remote, defaultBranch, token}`,
`get(name)` (a disposable handle; declare it with `using`), `list({limit, cursor})`, `import({source:{url,branch,depth}, target:{name}})`, `delete(name)`.

Repo handle: `info()`, `createToken(scope = "write", ttl?)`, `listTokens()`, `revokeToken()`,
`fork(name, {readOnly, defaultBranchOnly})`, `log({ref, limit, offset})`, `readCommit(hash)`,
`readTree(hash)`, `readBlob(hash)`, `readFile({ref, path})`.

The **binding and the REST API are read-only for content.** Commit through Git over HTTPS:
`https://x:${TOKEN}@<id>.artifacts.cloudflare.net/git/<repo>.git`. From a Worker, use
`isomorphic-git` + `isomorphic-git/http/web` + an in-memory FS
([example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)), or the Sandbox SDK.

REST: `GET /artifacts/namespaces/:ns/repos/:name/raw/:ref/:path` is handy for `<img src>` (through a proxy Worker).

Other details: git-notes are supported, and so are shallow clones. Event subscriptions (create/fork/push/clone/fetch/delete) → Queues.
Pricing: $0.15 per 1k ops (10k included), $0.50/GB-month (1 GB included). Billing starts Oct 15, 2026.

CLI: `cf artifacts namespaces ...`. Use `cf cli search "<task>"` to discover commands.

## Clef

`@cf/cloudflare/clef` (27B, ~210 ms text) and `@cf/cloudflare/clef-flash` (9B, ~40 ms). 64k context.
Output tokens aren't billed. Images: ≤4, base64 PNG/JPEG/WebP, no URLs. A 750 KB JPEG estimated ~200k tokens and was rejected;
a 384px WebP (~18 KB) works, and Clef with one image answered in 0.4–0.6 s. Call it with `model: "clef"|"clef-flash"` in the body; answers come under `answers`.

```json
{
  "state": { "note": "...", "prompt": "..." },
  "images": ["data:image/webp;base64,..."],
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "What change does `note` require for the shot in `prompt`?",
      "criteria": {
        "reseed": "Same description, just try another render",
        "rewrite_prompt": "Change this shot's framing/content",
        "edit_bible": "Change a character, place or style used across shots",
        "no_op": "Praise or no actionable change"
      }
    },
    "adherence": { "type": "score", "instructions": "How well does the image match `prompt`?",
                   "criteria": ["Unrelated", "Weak", "Partial", "Good", "Exact"] }
  }
}
```
Responses: `choice` → `{choice, probabilities, confidence}`; `score` → `{score, legend, probabilities, confidence}`; `noul` → `{noul: p}`.

## Models

Text-to-image (Workers AI): `@cf/black-forest-labs/flux-1-schnell` (fast drafts; input is only `prompt` + `steps`, no seed; ~750 KB JPEG out).
`flux-2-klein-9b` / `flux-2-dev` / `flux-2-klein-4b` take **multipart** input: build a `FormData` (`prompt`, `width`, `height`, `seed`,
`input_image_0..3` as Blobs, each <512×512), wrap it in `new Response(form)` and pass `{ multipart: { body: res.body, contentType: res.headers.get("content-type") } }`.
Steps are fixed at 4 on klein. Errors: 3030 = output flagged by the safety filter (retry with a new seed), 3043 = transient internal error.
Others: `flux-2-dev`,
`flux-2-klein-4b`/`flux-2-klein-9b` (multi-reference editing), `@cf/leonardo/phoenix-1.0`, `lucid-origin`, SDXL lightning.

Text generation: `kimi-k2.6`, `deepseek-v4-pro-0813`, `glm-5.3`, `nemotron-3-120b-a12b`, `gemma-4-26b-a4b-it`, `llama-3.3-70b-instruct-fp8-fast`.

Vision: `llama-3.2-11b-vision-instruct`, `moondream3.1-9B-A2B`, `mistral-small-3.1-24b-instruct`.

Video (unified catalog, through AI Gateway / `env.AI`; not in the Workers AI catalog itself):
image-to-video `alibaba/wan-2.7-i2v`, `alibaba/hh1.1-i2v`, `alibaba/hh1.1-r2v` (character reference);
text-to-video and image-to-video `google/veo-3.1(-fast)`, `bytedance/seedance-2.0(-fast|-mini)`, `runwayml/gen-4.5`,
`lightricks/ltx-2-5-fast`, `black-forest-labs/flux-3-video`, `pixverse/v6`, `minimax/hailuo-2.3`.

## Sources
- https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- https://www.cloudflare.com/git-competition/
- https://blog.cloudflare.com/artifacts-git-for-agents-beta/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-asset-creation/
- https://flaviocopes.com/clef/
- https://developers.cloudflare.com/workers-ai/models/ and https://developers.cloudflare.com/ai/models/
