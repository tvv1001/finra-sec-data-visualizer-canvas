import { NextRequest, NextResponse } from 'next/server';
import { lookupLocalSearchHitsByIds } from '@/lib/localSearch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
	try {
		const { cards } = await request.json();
		if (!Array.isArray(cards) || !cards.length) {
			return NextResponse.json({ cards: [] });
		}

		const finraIndividual = new Set<string>();
		const finraFirm = new Set<string>();
		const secIndividual = new Set<string>();
		const secFirm = new Set<string>();

		for (const card of cards) {
			const id = String(card?.id || '').trim();
			if (!id) continue;
			if (card.source === 'sec') {
				if (card.entity === 'firm') secFirm.add(id);
				else secIndividual.add(id);
			} else {
				if (card.entity === 'firm') finraFirm.add(id);
				else finraIndividual.add(id);
			}
		}

		const baseUrl = new URL(request.url).origin;
		const [fInd, fFirm, sInd, sFirm] = await Promise.all([
			lookupLocalSearchHitsByIds('finra', 'individual', Array.from(finraIndividual), { baseUrl }),
			lookupLocalSearchHitsByIds('finra', 'firm', Array.from(finraFirm), { baseUrl }),
			lookupLocalSearchHitsByIds('sec', 'individual', Array.from(secIndividual), { baseUrl }),
			lookupLocalSearchHitsByIds('sec', 'firm', Array.from(secFirm), { baseUrl }),
		]);

		const hydrated = cards.map((card) => {
			const hitMap =
				card.source === 'sec' ?
					card.entity === 'firm' ? sFirm : sInd
				: card.entity === 'firm' ? fFirm : fInd;

			const hit = hitMap.get(String(card.id));
			if (!hit) return card;

			const rawLabel =
				card.entity === 'firm' ?
					hit.firm_name || hit.firmName || card.label
				:	[hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ') || hit.individualName || card.label;

			const city = hit.city || hit.firm_city || hit.branch_city;
			const state = hit.state || hit.firm_state || hit.branch_state;
			const address = [city, state].filter(Boolean).join(', ');

			const otherNamesRaw = hit.ind_other_names || hit.firm_other_names || hit.otherNames || hit.aliases;
			const otherNames = Array.isArray(otherNamesRaw) ? otherNamesRaw.map((n: unknown) => String(n || '').trim()).filter(Boolean) : [];

			return {
				...card,
				rawLabel,
				rawAddress: address,
				otherNames: otherNames.length > 0 ? Array.from(new Set(otherNames)) : card.otherNames,
				hydratedFromSidecar: true,
			};
		});

		return NextResponse.json({ cards: hydrated });
	} catch (error) {
		console.error('hydrate-search-cards error:', error);
		return NextResponse.json({ error: 'Failed to hydrate search cards' }, { status: 500 });
	}
}
