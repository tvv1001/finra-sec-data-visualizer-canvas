/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * dataMerge.ts – Merge FINRA and SEC data from local cached files.
 * Ported from server/services/dataMerge/mergeFinraSec.js
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './constants';
import { getFullGraph } from './graphStore';

const BASE = path.join(DATA_DIR, 'national');
const FINRA_DIR = path.join(BASE, 'brokercheck.finra.org');
const SEC_DIR = path.join(BASE, 'adviserinfo.sec.gov');

let _loaded = false;
const finraIndividuals = new Map<string, any>();
const secIndividuals = new Map<string, any>();

async function _loadFinraFiles() {
	try {
		const files = await readdir(FINRA_DIR);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			if (!f.startsWith('dl_') && !f.startsWith('query_') && !f.startsWith('individual_') && !f.startsWith('summary_') && !f.startsWith('api.brokercheck.finra.org_search_'))
				continue;
			try {
				const raw = await readFile(path.join(FINRA_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const hits = json?.hits?.hits || [];
				for (const h of hits) {
					const src = h._source || {};
					let id = src.ind_source_id || src.person?.crd || src.firm_id;
					if (src.content) {
						try {
							const parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
							if (parsed?.currentEmployments) src.ind_current_employments = parsed.currentEmployments;
							if (parsed?.previousEmployments) src.ind_previous_employments = parsed.previousEmployments;
							if (!id) id = parsed?.basicInformation?.individualId || parsed?.basicInformation?.crd || id;
						} catch {}
					}
					if (!id) continue;
					if (src.ind_source_id) finraIndividuals.set(String(src.ind_source_id), src);
					else finraIndividuals.set(String(id), src);
				}
			} catch {}
		}
	} catch {}
}

async function _loadSecFiles() {
	try {
		const files = await readdir(SEC_DIR);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw = await readFile(path.join(SEC_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const hits = json?.hits?.hits || [];
				for (const h of hits) {
					const src = h._source || {};
					let id = src.ind_source_id || src.person?.crd || src.firm_id;
					if (src.content) {
						try {
							const parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
							if (parsed?.currentEmployments) src.ind_current_employments = parsed.currentEmployments;
							if (parsed?.previousEmployments) src.ind_previous_employments = parsed.previousEmployments;
							if (!id) id = parsed?.basicInformation?.individualId || parsed?.basicInformation?.crd || id;
						} catch {}
					}
					if (!id) continue;
					if (src.ind_source_id) secIndividuals.set(String(src.ind_source_id), src);
					else if (id) secIndividuals.set(String(id), src);
				}
			} catch {}
		}
	} catch {}
}

async function ensureLoaded() {
	if (_loaded) return;
	_loaded = true;
	await Promise.all([_loadFinraFiles(), _loadSecFiles()]);
}

function _pickIndividualFields(src: any) {
	if (!src) return null;
	let parsed: any = null;
	if (src.content) {
		try {
			parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
		} catch {}
	}
	return {
		ind_source_id: src.ind_source_id,
		firstName: src.ind_firstname || src.firstName || null,
		middleName: src.ind_middlename || src.middleName || null,
		lastName: src.ind_lastname || src.lastName || null,
		otherNames: src.ind_other_names || src.otherNames || [],
		bcScope: src.ind_bc_scope || src.bcScope || null,
		iaScope: src.ind_ia_scope || src.iaScope || null,
		disclosureFlag: src.ind_bc_disclosure_fl || src.disclosureFlag || null,
		industryCalDate: src.ind_industry_cal_date || src.industryCalDate || src.ind_industry_cal_date_iapd || null,
		currentEmployments: src.ind_current_employments || src.ind_ia_current_employments || (parsed ? parsed.currentEmployments || [] : []),
		previousEmployments: src.ind_previous_employments || src.ind_ia_previous_employments || (parsed ? parsed.previousEmployments || [] : []),
	};
}

function _eq(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function computeDiffs(finra: any, sec: any) {
	const f = _pickIndividualFields(finra);
	const s = _pickIndividualFields(sec);
	const diffs: Record<string, any> = {};
	const keys = new Set([...(f ? Object.keys(f) : []), ...(s ? Object.keys(s) : [])]);
	for (const k of keys) {
		const fv = f ? (f as any)[k] : undefined;
		const sv = s ? (s as any)[k] : undefined;
		diffs[k] = { finra: fv ?? null, sec: sv ?? null, equal: _eq(fv, sv) };
	}
	return { finra: f, sec: s, diffs };
}

export async function mergedIndividual(crd: string) {
	await ensureLoaded();
	const id = String(crd);
	const finra = finraIndividuals.get(id) || null;
	const sec = secIndividuals.get(id) || null;
	const computed = computeDiffs(finra, sec);
	return {
		crd: id,
		found: !!(finra || sec),
		sources: { finra: finra || null, sec: sec || null },
		merged: computed,
	};
}

export async function mergedFirm(firmId: string) {
	await ensureLoaded();
	const id = String(firmId);
	const finraGraph = await getFullGraph();
	let firmNode: any = null;
	if (finraGraph && Array.isArray(finraGraph.nodes)) {
		firmNode = finraGraph.nodes.find((n: any) => n.group === 'firm' && String(n.firmId) === id);
	}

	const evidence: any[] = [];
	for (const [personKey, v] of finraIndividuals.entries()) {
		const emps = [...(v.ind_current_employments || []), ...(v.ind_previous_employments || []), ...(v.ind_ia_current_employments || []), ...(v.ind_ia_previous_employments || [])];
		for (const e of emps) {
			const fid = e?.firm_id || e?.firmId || null;
			if (!fid) continue;
			if (String(fid) === id) evidence.push({ personId: personKey, employment: e });
		}
	}

	return {
		firmId: id,
		found: !!(firmNode || evidence.length),
		finraNode: firmNode || null,
		evidence,
	};
}
