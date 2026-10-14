// A remake (D48): another board's plan made again with other models. These rules say what the copy keeps
// and what it clears, so no portrait, set or frame from the old renderer sits beside the new ones.
import type { CsvRow } from "./csv.ts";

/** Everything a renderer (or a take) made: each cell's outputs, the cast's portraits and the scouted sets. */
const MADE = [/^cells\/[^/]+\/(frame\.webp|render\.json|review\.json|continuity\.json|inspection\.json|idea\.md|edit\.md|prompt\.md)$/, /^bible\/(refs|locations)\//];

/** The files a remake removes from the copy; the plan, the beats, the bible and the notes stay. */
export const remakeClears = (paths: string[]) => paths.filter((p) => MADE.some((re) => re.test(p)));

/** Every cell back to a draft with no printed take. */
export const remakeRows = (rows: CsvRow[]): CsvRow[] => rows.map((r) => ({ ...r, status: "draft", take: "" }));
