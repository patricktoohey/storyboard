// The AI Gateway's prepaid credits (D39). Third-party models (the frontier leads and judges, most video
// models) are paid from them, and when they run out every call fails with 2021: Season 2's round 2 panel
// and its whole finale were lost that way. A season checks the balance before it starts.
//
// Reading the balance takes an API token with AI Gateway Read, which the Worker doesn't otherwise need:
// CF_ACCOUNT_ID and AI_GATEWAY_TOKEN in .env (deploy.sh uploads .env as secrets). Without them there's no
// check, and the season starts as before.

// What a team spends of its budget in a round, by Season 2's first two rounds (75% and 53% on average)
export const SPEND_SHARE = 0.75;
// The panel: three frontier judges, every pair both ways, films, endings and process records
export const PANEL_USD = 2;

/** What a season can be expected to cost, at most: every team spending its usual share, every round judged. */
export function seasonEstimate(rounds: number, teams: number, budget: number) {
	return Number((rounds * (teams * budget * SPEND_SHARE + PANEL_USD)).toFixed(2));
}

/** The balance in dollars, or undefined when the Worker has no token to read it with. */
export async function creditBalance(env: Env): Promise<number | undefined> {
	const { CF_ACCOUNT_ID: account, AI_GATEWAY_TOKEN: token } = env as unknown as Record<string, string | undefined>;
	if (!account || !token) return undefined;
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/billing/credit-balance`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { balance?: number }; errors?: { message: string }[] };
	if (!body.success || typeof body.result?.balance !== "number") {
		throw new Error(`credit balance: HTTP ${res.status} ${(body.errors ?? []).map((e) => e.message).join("; ")}`);
	}
	return body.result.balance;
}

/** Why a season shouldn't start on this balance, if it shouldn't. */
export function tooLittle(balance: number | undefined, estimate: number) {
	if (balance === undefined || balance >= estimate) return undefined;
	return `the AI Gateway has $${balance.toFixed(2)} in credits and this season can cost about $${estimate.toFixed(2)}; top up, or send "ignore_credits": true`;
}
