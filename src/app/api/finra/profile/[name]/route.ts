import { NextRequest, NextResponse } from 'next/server';
import { getProfilesFromStore } from '@/lib/seedStore';
import { sharedCacheHeaders } from '@/lib/httpCache';

async function getProfilesData() {
	return getProfilesFromStore();
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	if (name === 'custom') {
		return NextResponse.json(
			{
				name: 'custom',
				description: '',
				enabled: false,
				seeds: [],
				individuals: [],
				firms: [],
			},
			{ headers: sharedCacheHeaders(300) },
		);
	}
	const pr = await getProfilesData();
	if (!Array.isArray(pr.profiles)) {
		return NextResponse.json({ error: 'No profiles defined' }, { status: 404 });
	}
	const prof = pr.profiles.find((p: any) => p.name === name);
	if (!prof) {
		return NextResponse.json({ error: `Profile '${name}' not found` }, { status: 404 });
	}
	return NextResponse.json(
		{
			name: prof.name,
			description: prof.description || '',
			enabled: typeof prof.enabled === 'boolean' ? prof.enabled : true,
			seeds: Array.isArray(prof.seeds) ? prof.seeds : [],
			individuals: Array.isArray(prof.individuals) ? prof.individuals.map(Number).filter(Boolean) : [],
			firms: Array.isArray(prof.firms) ? prof.firms.map(Number).filter(Boolean) : [],
		},
		{ headers: sharedCacheHeaders(300) },
	);
}
