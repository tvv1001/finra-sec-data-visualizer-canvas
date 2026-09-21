import { describe, expect, it } from 'vitest';
import { extractConnectionCards } from '@/app/dashboard/page';
import { partitionConnectionsByFilter } from '@/lib/filterTags';

describe('7691 previous roster extract + filter', () => {
  it('includes 1085996 and surfaces it for timothy dale', async () => {
    const conn = await fetch('http://127.0.0.1:4444/api/finra/firm/7691/connections?bucket=previous&light=1').then((r) => r.json());
    const cards = extractConnectionCards(conn, 'previousConnections');
    expect(cards.length).toBeGreaterThan(1000);
    const hit = cards.find((c) => c?.crd === '1085996');
    expect(hit?.title).toMatch(/Timothy Dale Register/i);
    const partitioned = partitionConnectionsByFilter(
      cards,
      (item) => item.haystack || [item.title, item.crd, ...(item.otherNames || [])].join(' '),
      [],
      'timothy dale',
      true,
      false,
    );
    expect(partitioned.matched.map((c) => c.crd)).toContain('1085996');
    expect(partitioned.matched[0]?.crd).toBe('1085996');
  }, 30000);
});
