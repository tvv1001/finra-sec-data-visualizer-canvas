import { NextRequest, NextResponse } from 'next/server';
import { getProfilesFromStore, saveProfilesToStore } from '@/lib/seedStore';

export async function POST(request: NextRequest) {
	const body = await request.json();
	const { profile, individuals, firms } = body;

	if (typeof profile !== 'string') {
		return NextResponse.json({ error: 'profile must be a string' }, { status: 400 });
	}
	if (individuals && !Array.isArray(individuals)) {
		return NextResponse.json({ error: 'individuals must be an array' }, { status: 400 });
	}
	if (firms && !Array.isArray(firms)) {
		return NextResponse.json({ error: 'firms must be an array' }, { status: 400 });
	}

	const profilesData = await getProfilesFromStore();
	let prof = profilesData.profiles?.find((p: any) => p.name === profile);
	if (!prof) {
		// Auto-create the profile if it doesn't exist
		if (!Array.isArray(profilesData.profiles)) profilesData.profiles = [];
		prof = { name: profile, description: '', enabled: false, seeds: [], individuals: [], firms: [] };
		profilesData.profiles.push(prof);
	}

	if (individuals) {
		prof.individuals = [...new Set([...(prof.individuals || []), ...individuals])];
	}
	if (firms) {
		prof.firms = [...new Set([...(prof.firms || []), ...firms])];
	}

	await saveProfilesToStore(profilesData);

	return NextResponse.json({
		ok: true,
		added: {
			individuals: individuals?.length || 0,
			firms: firms?.length || 0,
		},
	});
}
