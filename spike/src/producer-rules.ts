// The producer's notes, and boards carried into a new round (D40). Season 2's teams worked alone: a human
// watching a teaser go wrong (a clip voicing its own line under the team's) had no way to say so except
// by writing a note into a cell, which became work the lead never knew came from outside. A producer note
// is a commit on the board under the producer's name; the lead sees it on its next turn and must answer,
// by acting on it or saying why not, and its answer is committed beside the note. The panel reads both.
//
// A board carried over from an earlier round keeps every branch, so its old cuts exist; this round's
// submission must be a new one. Pure: test/producer.test.ts.

export const PRODUCER_NOTES = "notes/producer.json";
export const PRODUCER = "producer";

export interface ProducerNote {
	id: number;
	at: string;
	note: string;
	// A shot, or the whole board when absent
	cell?: string;
	answer?: { at: string; turn: number; action: string; reply: string };
}

/** The notes with a new one added. */
export function addProducerNote(notes: ProducerNote[], note: string, at: string, cell?: string): ProducerNote[] {
	const id = Math.max(0, ...notes.map((n) => n.id)) + 1;
	return [...notes, { id, at, note: note.trim().slice(0, 1000), ...(cell ? { cell } : {}) }];
}

export const openNotes = (notes: ProducerNote[]) => notes.filter((n) => !n.answer);

/** Every open note answered by one reply, with the move the lead made beside it. */
export function answerNotes(notes: ProducerNote[], reply: string, turn: number, action: string, at: string): ProducerNote[] {
	return notes.map((n) => (n.answer ? n : { ...n, answer: { at, turn, action, reply: reply.trim().slice(0, 300) } }));
}

/** What the lead sees: open notes to answer, and what it said to the last few it answered. */
export function producerView(notes: ProducerNote[]) {
	const open = openNotes(notes);
	const answered = notes.filter((n) => n.answer).slice(-3);
	if (!open.length && !answered.length) return undefined;
	return {
		...(open.length
			? {
					open: open.map((n) => ({ ...(n.cell ? { cell: n.cell } : { to: "the whole board" }), note: n.note })),
					must: 'Answer in "to_producer": what you are doing about it this turn or next, or why you won\'t. You decide, but the panel reads your answer beside the note.',
				}
			: {}),
		...(answered.length ? { answered: answered.map((n) => ({ note: n.note, you_said: n.answer!.reply })) } : {}),
	};
}

/** The notes as the panel reads them in a team's process record, placed at the minute they arrived. */
export function producerLines(notes: ProducerNote[], minute: (iso?: string) => string) {
	return notes.map((n) => ({
		at: Date.parse(n.at),
		line: `- at ${minute(n.at)}: THE PRODUCER'S NOTE${n.cell ? ` on cell ${n.cell}` : ""}: "${n.note.slice(0, 300)}" → ${
			n.answer ? `answered on turn ${n.answer.turn} (${n.answer.action}): "${n.answer.reply}"` : "never answered"
		}`,
	}));
}

/** Where a carried-over board came from, as its board.json records it. */
export interface CarriedFrom {
	board: string;
	commit: string;
	// The earlier round's cuts, saved versions and comparisons: kept to look at and learn from, but never
	// submitted or judged as this round's work
	cuts: string[];
	saved: string[];
	comparisons: number;
}

/** This round's cuts, newest first as listed: a carried-over board's earlier cuts don't count. */
export const roundCuts = (cuts: string[], from?: CarriedFrom) => (from ? cuts.filter((c) => !from.cuts.includes(c)) : cuts);
