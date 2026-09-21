import type { Redis as UpstashRedis } from '@upstash/redis';

export async function zaddRaw(client: UpstashRedis | null, key: string, score: number, member: string): Promise<void> {
	if (!client) return;
	try {
		// best-effort: call zadd with the simple signature; some typing mismatches exist in @upstash/redis types
		await (client as any).zadd(key, score, member);
	} catch (e) {
		try {
			// fallback to options-style signature if available
			await (client as any).zadd(key, { NX: true }, { score, member });
		} catch (_err) {
			// swallow — this operation is best-effort
		}
	}
}

export default zaddRaw;
