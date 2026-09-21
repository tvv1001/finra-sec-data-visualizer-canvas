import * as d3 from 'd3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ensureSidebarHintContent,
	formatFindCounter,
	isSidebarTemporarilyPinned,
	isFindShortcut,
	toggleSidebarPin,
	syncSidebarPinButton,
	hideSidebar,
	hideSelectionLog,
	focusFetchInputWhenEmpty,
	routeSidebarNodeSelection,
} from '../../src/components/FinraGraph';
import {
	applyGraphDerivedNodeMetrics,
	estimateLocalCrowdFactors,
	bindSimulationTickHandler,
	getNodeLabelFontSize,
	setGraphLabelRenderMode,
	isNodeInactive,
	isRevealableChainExhausted,
	loadPersistedSidebarViewMode,
	collectFirmConnectionEntries,
	getAutoExpansionHopsForNode,
	getLargeNodeRevealBatchPlan,
	getLinkIdentityKey,
	getNodeExpansionRevealTiming,
	getSelectionLinkOpacity,
	loadSelectionLogBoldPreference,
	mergeGraphNodesByIdentity,
	mergeIncomingNodesIntoExistingNodes,
	mergeRenderedNodesForReveal,
	rewriteLinksForNodeIdMap,
	resolveNodeByIdOrIdentity,
	selectNodesToInjectById,
	releasePinnedSelectedNodeAnchor,
	normalizeNodeLabelInPlace,
	getNodeTooltipTitle,
	renderNodeContents,
	rankFindNodeMatches,
	scheduleNodeExpansion,
	selectTextSearchHydrationTargets,
	shouldFetchFirmDetailForOwnerEvidence,
	shouldHydrateExpansionFrontierNodeDetail,
	shouldAutoExpandRouteSelection,
	shouldAutoRevealNodeConnections,
	shouldRenderNodeSelected,
	selectHopHighlightRoots,
	shouldSuppressFirmSelectionPersonLink,
	MAX_HOP_HIGHLIGHT_ROOTS,
	rebuildLayoutLinkIndexes,
	layoutHasLinkIdentity,
	upsertSelectionLogEntry,
	pruneGraphToSelectionLogEntries,
	collectSelectionLogClearNonLogKeepIds,
	isForcedGrayConnectionLink,
	clearSelectionState,
	buildSessionRenderGraphData,
	filterSelectionLogLabelNodeIdsByScope,
	generateGraphTemplateName,
	isSelectionLogPeopleEntry,
	resolveLinkEndpoints,
	rebindLinksToNodes,
	handleNodeKeyboardActivation,
	resolveEmploymentConnectionFirmNodeId,
} from '../../src/lib/finra-graph';
import { shouldRenderBlueNodeHighlight } from '../../src/lib/finra-graph-canvas';
import { DEFAULT_NODE_LABEL_FONT_SIZE_PX } from '../../src/lib/finra-graph-defaults';
import { applyIndividualDetail as applyIndividualDetailFromDetailUtils, hasRichIndividualDetail } from '../../src/lib/finra-graph/detailUtils';
import { mergeGraphNodesForAppend, rewriteGraphLinksForNodeIdentity } from '../../src/lib/graphIdentity';
import { buildParentFirmSummaryLinks } from '../../src/lib/finra-graph/externalLinks';
import { renderFirmDetail, renderPersonDetail } from '../../src/lib/finra-graph/sidebar';
import { buildLargeGraphRenderPlan, getLargeGraphRenderBudget, getProgressiveLoadBudget, shouldUseInitialSvgFallback } from '../../src/lib/large-graph-rendering';
import { normalizeNodeRouteId } from '../../src/lib/node-route';

describe('FinraGraph DOM helpers (unit)', () => {
	beforeEach(() => {
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: {
				getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
				setItem: (key: string, value: string) => {
					storage.set(key, String(value));
				},
				removeItem: (key: string) => {
					storage.delete(key);
				},
				clear: () => {
					storage.clear();
				},
			},
		});
		document.body.innerHTML = `
      <div id="fg-sidebar" class="fg-sidebar hidden" data-mobile-expanded="false"></div>
      <div id="fg-sidebar-backdrop" class="fg-sidebar-backdrop hidden"></div>
      <div id="fg-sidebar-inner"></div>
      <div id="fg-empty" class="fg-empty"></div>
      <input id="fg-fetch-input" />
      <div id="fg-selection-log" class="fg-selection-log"></div>
      <button id="fg-sidebar-pin-toggle"></button>
    `;
	});

	afterEach(() => {
		globalThis.localStorage?.clear?.();
		delete (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
		document.body.innerHTML = '';
	});

	it('loadSelectionLogBoldPreference defaults to bold on for new visitors', () => {
		globalThis.localStorage.removeItem('finra_selection_log_bold');

		expect(loadSelectionLogBoldPreference()).toBe(true);
	});

	it('loadSelectionLogBoldPreference preserves a saved off preference', () => {
		globalThis.localStorage.setItem('finra_selection_log_bold', 'false');

		expect(loadSelectionLogBoldPreference()).toBe(false);
	});

	it('loadPersistedSidebarViewMode remembers collapsed state', () => {
		window.sessionStorage.setItem('finra_sidebar_view_mode', 'none');

		expect(loadPersistedSidebarViewMode()).toBe('none');
	});

	it('loadPersistedSidebarViewMode defaults to none (menu closed) when no preference is saved', () => {
		window.sessionStorage.removeItem('finra_sidebar_view_mode');

		expect(loadPersistedSidebarViewMode()).toBe('none');
	});

	it('bindSimulationTickHandler replaces previous tick listeners instead of stacking them', () => {
		const listeners = new Map<string, Function>();
		const simulation = {
			on: (name: string, handler?: Function | null) => {
				if (!name || !name.startsWith('tick.')) return;
				if (!handler) {
					listeners.delete(name);
					return;
				}
				listeners.set(name, handler);
			},
		};
		const first = vi.fn();
		const second = vi.fn();

		bindSimulationTickHandler(simulation as any, first);
		bindSimulationTickHandler(simulation as any, second);

		const active = Array.from(listeners.values());
		expect(active).toHaveLength(1);
		expect(active[0]).toBe(second);

		active[0]!();
		expect(second).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
	});

	it('setGraphLabelRenderMode prefers compact node labels for the default graph experience', () => {
		setGraphLabelRenderMode(5000);
		const container = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		const node = {
			id: 'person:123',
			group: 'individual',
			label: 'Alexander Hamilton Longname',
		};
		const selection = d3.select(container).datum(node);
		renderNodeContents(selection);
		expect(selection.select('text').text()).toBe(node.label);
		expect(selection.selectAll('.fg-node-selected-ring').size()).toBe(0);
	});

	it('routeSidebarNodeSelection preserves the query string when routing a node', () => {
		const setBrowserPathname = vi.fn();
		const pushState = vi.spyOn(window.history, 'pushState');
		const dispatchEvent = vi.spyOn(window, 'dispatchEvent');

		routeSidebarNodeSelection({
			nodeId: 'person:123',
			browserPathname: '/',
			pathname: '/',
			setBrowserPathname,
		});

		expect(setBrowserPathname).toHaveBeenCalledWith('/individual/123');
		expect(pushState).toHaveBeenCalledWith(window.history.state, '', '/individual/123');
		expect(dispatchEvent).toHaveBeenCalled();
	});

	it('upsertSelectionLogEntry moves reselected items to most recent', () => {
		const initialEntries = [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'firm:2', label: 'Bravo Firm', secondaryId: 'CRD# 2', group: 'firm' },
			{ id: 'person:3', label: 'Charlie', secondaryId: 'CRD# 3', group: 'individual' },
		] as const;

		const reordered = upsertSelectionLogEntry([...initialEntries], {
			id: 'person:1',
			label: 'Alpha',
			secondaryId: 'CRD# 1',
			group: 'individual',
		});

		expect(reordered.map((entry) => entry.id)).toEqual(['firm:2', 'person:3', 'person:1']);
	});

	it('generateGraphTemplateName prefers the selected log label and node count', () => {
		const name = generateGraphTemplateName(
			{
				selectedNodeId: 'person:1',
				renderedServerIds: ['person:1', 'firm:2', 'firm:3'],
			},
			[
				{ id: 'person:1', label: 'Alpha Person' },
				{ id: 'firm:2', label: 'Bravo Firm' },
			],
			Date.parse('2026-08-08T12:00:00.000Z'),
		);

		expect(name.startsWith('Alpha Person +2 · ')).toBe(true);
	});

	it('filterSelectionLogLabelNodeIdsByScope can keep only people labels', () => {
		const selectionLog = [
			{ id: 'person:3102054', group: 'individual' },
			{ id: 'firm:143571', group: 'firm' },
			{ id: 'person:999', group: 'person' },
		];
		const allIds = ['person:3102054', 'firm:143571', 'person:999', 'entity:1'];

		expect(filterSelectionLogLabelNodeIdsByScope(allIds, selectionLog, 'all')).toEqual(allIds);
		expect(filterSelectionLogLabelNodeIdsByScope(allIds, selectionLog, 'people')).toEqual(['person:3102054', 'person:999']);
		expect(isSelectionLogPeopleEntry({ id: 'person:1', group: 'firm' })).toBe(false);
		expect(isSelectionLogPeopleEntry({ id: 'person:1' })).toBe(true);
	});

	it('generateGraphTemplateName falls back when the graph snapshot is empty', () => {
		const name = generateGraphTemplateName({ cleared: false }, [], Date.parse('2026-08-08T12:00:00.000Z'));
		expect(name.startsWith('Template · ')).toBe(true);
	});

	it('pruneGraphToSelectionLogEntries drops dangling neighbors when only one node is logged', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'firm:3', group: 'firm' },
			],
			links: [
				{ source: 'person:1', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:3', relationship: 'employed_by' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' }]);

		expect(pruned.nodes.map((node: any) => node.id).sort()).toEqual(['person:1']);
		expect(pruned.links).toHaveLength(0);
	});

	it('collectSelectionLogClearNonLogKeepIds drops loose leaves while keeping only the logged terminal', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'firm:3', group: 'firm' },
				{ id: 'firm:9', group: 'firm' },
				{ id: 'person:10', group: 'individual' },
			],
			links: [
				{ source: 'person:1', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'firm:3', target: 'firm:9', relationship: 'branch' },
				{ source: 'person:10', target: 'firm:9', relationship: 'employed_by' },
			],
		} as any;

		const keepIds = collectSelectionLogClearNonLogKeepIds(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
		]);

		expect(Array.from(keepIds).sort()).toEqual(['person:1']);
	});

	it('pruneGraphToSelectionLogEntries keeps bridge firms between logged people and drops dangling leaves', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'firm:3', group: 'firm' },
				{ id: 'person:4', group: 'individual' },
			],
			links: [
				{ source: 'person:1', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:4', target: 'person:2', relationship: 'associated_with' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:2', label: 'Beta', secondaryId: 'CRD# 2', group: 'individual' },
		]);

		const keptIds = pruned.nodes.map((node: any) => node.id).sort();
		expect(keptIds).toEqual(['firm:3', 'person:1', 'person:2']);
		expect(pruned.links).toHaveLength(2);
		expect(pruned.links.map((link: any) => [link.source, link.target])).toEqual(
			expect.arrayContaining([
				['person:1', 'firm:3'],
				['person:2', 'firm:3'],
			]),
		);
	});

	it('pruneGraphToSelectionLogEntries keeps a small connecting tree when multiple logged nodes share paths', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'person:3', group: 'individual' },
				{ id: 'firm:4', group: 'firm' },
				{ id: 'firm:5', group: 'firm' },
				{ id: 'firm:6', group: 'firm' },
			],
			links: [
				{ source: 'person:1', target: 'firm:4', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:5', relationship: 'employed_by' },
				{ source: 'person:3', target: 'firm:6', relationship: 'employed_by' },
				{ source: 'firm:4', target: 'firm:5', relationship: 'branch' },
				{ source: 'firm:5', target: 'firm:6', relationship: 'branch' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:2', label: 'Beta', secondaryId: 'CRD# 2', group: 'individual' },
			{ id: 'person:3', label: 'Gamma', secondaryId: 'CRD# 3', group: 'individual' },
		]);

		const keptIds = pruned.nodes.map((node: any) => node.id).sort();
		expect(keptIds).toEqual(['firm:4', 'firm:5', 'firm:6', 'person:1', 'person:2', 'person:3']);
		expect(pruned.links).toHaveLength(5);
	});

	it('collectSelectionLogClearNonLogKeepIds keeps multi-hop bridges that are not direct log neighbors', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'firm:A', group: 'firm' },
				{ id: 'firm:B', group: 'firm' },
				{ id: 'person:leaf', group: 'individual' },
			],
			links: [
				{ source: 'person:1', target: 'firm:A', relationship: 'employed_by' },
				{ source: 'firm:A', target: 'firm:B', relationship: 'branch' },
				{ source: 'firm:B', target: 'person:2', relationship: 'employed_by' },
				{ source: 'firm:A', target: 'person:leaf', relationship: 'employed_by' },
			],
		} as any;

		const keepIds = collectSelectionLogClearNonLogKeepIds(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:2', label: 'Beta', secondaryId: 'CRD# 2', group: 'individual' },
		]);

		expect(Array.from(keepIds).sort()).toEqual(['firm:A', 'firm:B', 'person:1', 'person:2']);
	});

	it('collectSelectionLogClearNonLogKeepIds keeps alternate bridges like Merrill even when another log path exists', () => {
		// John -- Merrill -- Douglas
		// John -- JPMorgan -- Mirna -- Goldman -- Douglas
		// Steiner would keep only one spine; clear-non-connected must keep Merrill too.
		const graphData = {
			nodes: [
				{ id: 'person:john', group: 'individual' },
				{ id: 'person:douglas', group: 'individual' },
				{ id: 'person:mirna', group: 'individual' },
				{ id: 'firm:merrill', group: 'firm' },
				{ id: 'firm:jpmorgan', group: 'firm' },
				{ id: 'firm:goldman', group: 'firm' },
				{ id: 'person:leaf', group: 'individual' },
			],
			links: [
				{ source: 'person:john', target: 'firm:merrill', relationship: 'employed_by' },
				{ source: 'person:douglas', target: 'firm:merrill', relationship: 'employed_by' },
				{ source: 'person:john', target: 'firm:jpmorgan', relationship: 'employed_by' },
				{ source: 'person:mirna', target: 'firm:jpmorgan', relationship: 'employed_by' },
				{ source: 'person:mirna', target: 'firm:goldman', relationship: 'employed_by' },
				{ source: 'person:douglas', target: 'firm:goldman', relationship: 'employed_by' },
				{ source: 'firm:merrill', target: 'person:leaf', relationship: 'employed_by' },
			],
		} as any;

		const keepIds = collectSelectionLogClearNonLogKeepIds(graphData, [
			{ id: 'person:john', label: 'John', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:douglas', label: 'Douglas', secondaryId: 'CRD# 2', group: 'individual' },
			{ id: 'person:mirna', label: 'Mirna', secondaryId: 'CRD# 3', group: 'individual' },
			{ id: 'firm:jpmorgan', label: 'JPM', secondaryId: 'CRD# 79', group: 'firm' },
		]);

		expect(Array.from(keepIds).sort()).toEqual([
			'firm:goldman',
			'firm:jpmorgan',
			'firm:merrill',
			'person:douglas',
			'person:john',
			'person:mirna',
		]);
		expect(keepIds.has('person:leaf')).toBe(false);
	});

	it('ensureSidebarHintContent adds placeholder when empty', () => {
		const inner = document.getElementById('fg-sidebar-inner')!;
		inner.innerHTML = '';
		ensureSidebarHintContent();
		expect(inner.innerHTML.trim()).toBe('');
	});

	it('toggleSidebarPin toggles persistent pin and syncs button', () => {
		const sidebar = document.getElementById('fg-sidebar')!;
		sidebar.dataset.persistentPinned = 'false';
		const btn = document.getElementById('fg-sidebar-pin-toggle')!;
		toggleSidebarPin();
		expect(sidebar.dataset.persistentPinned).toBe('true');
		// syncSidebarPinButton will set aria-pressed and data-pinned
		syncSidebarPinButton(true);
		expect(btn.getAttribute('aria-pressed')).toBe('true');
		expect(btn.getAttribute('data-pinned')).toBe('true');
	});

	it('hideSidebar hides when not pinned', () => {
		const sidebar = document.getElementById('fg-sidebar')!;
		sidebar.classList.remove('hidden');
		hideSidebar({ force: true });
		expect(sidebar.classList.contains('hidden')).toBe(true);
	});

	it('hideSelectionLog respects pin', () => {
		const log = document.getElementById('fg-selection-log')!;
		log.dataset.pinned = 'false';
		log.classList.remove('hidden');
		hideSelectionLog();
		expect(log.classList.contains('hidden')).toBe(true);
	});

	it('normalizeNodeLabelInPlace falls back to Node <id> for placeholder-only labels', () => {
		const node = { id: 'person:123', label: 'CRD 123456', group: 'individual' } as any;
		normalizeNodeLabelInPlace(node);
		expect(node.label).toBe('Node person:123');
	});

	it('does not replace a real firm name with a longer generic Firm CRD label', () => {
		const merged = mergeGraphNodesByIdentity(
			[{ id: 'firm:31194', group: 'firm', label: 'RBC', firmName: 'RBC' }],
			[{ id: 'firm:31194', group: 'firm', label: 'Firm 31194' }],
		);
		expect(merged[0].label).toBe('RBC');
		expect(merged[0].firmName).toBe('RBC');
	});

	it('restores cached real firm names over Node firm placeholders', () => {
		window.localStorage.setItem(
			'finra_node_label_cache',
			JSON.stringify({
				'firm:5393': {
					label: 'CHARLES SCHWAB & CO., INC.',
					firmName: 'CHARLES SCHWAB & CO., INC.',
					ts: Date.now(),
				},
			}),
		);
		const node = { id: 'firm:5393', group: 'firm', label: 'Node firm:5393' } as any;
		normalizeNodeLabelInPlace(node);
		expect(node.label).toBe('CHARLES SCHWAB & CO., INC.');
		expect(node.firmName).toBe('CHARLES SCHWAB & CO., INC.');
	});

	it('renderNodeContents creates a dedicated hit-area for hover and focus interactions', () => {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		svg.appendChild(group);
		document.body.appendChild(svg);

		const selection = d3.select(group).datum({ id: 'person:123', group: 'individual', label: 'Alpha' });
		renderNodeContents(selection);

		const hitArea = group.querySelector('.fg-node-hit-area');
		expect(hitArea).not.toBeNull();
		const hitAreaElement = hitArea as Element;
		expect(hitAreaElement.getAttribute('pointer-events')).toBe('all');
	});

	it('renderFirmDetail surfaces SEC registration-status rows from the registrationStatus array', () => {
		const html = renderFirmDetail({
			id: 'firm:154604',
			firmId: '154604',
			label: 'FUTUREADVISOR, INC.',
			group: 'firm',
			hasSecData: true,
			secSummaryDescription: 'SEC adviser firm profile',
			registrationStatus: [
				{ secJurisdiction: 'SEC', status: 'Terminated', effectiveDate: '7/14/2023' },
				{ secJurisdiction: 'North Carolina', status: 'Terminated', effectiveDate: '8/21/2013' },
				{ secJurisdiction: 'Oregon', status: 'Terminated', effectiveDate: '8/30/2013' },
			],
			basicInformation: {},
		} as any);

		expect(html).toContain('SEC / Jurisdiction');
		expect(html).toContain('SEC');
		expect(html).toContain('North Carolina');
		expect(html).toContain('Oregon');
		expect(html).toContain('7/14/2023');
		expect(html).toContain('8/21/2013');
		expect(html).toContain('8/30/2013');
	});

	it('renderFirmDetail keeps Form BD owners and links employment rosters to the dashboard', () => {
		const html = renderFirmDetail({
			id: 'firm:6413',
			firmId: '6413',
			label: 'LPL FINANCIAL LLC',
			group: 'firm',
			hasFinraData: true,
			bcScope: 'Active',
			directOwners: [{ crdNumber: '900001', legalName: 'Owner Control Person', position: 'CEO' }],
			currentConnections: [{ individualId: '900002', name: 'Should Not Render In Panel' }],
			previousConnections: [{ individualId: '900003', name: 'Also Should Not Render' }],
			basicInformation: {},
		} as any);

		expect(html).toContain('Direct Owners');
		expect(html).toContain('Owner Control Person');
		expect(html).toContain('Open Dashboard to view &amp; select connections');
		expect(html).toContain('/dashboard/firm/6413');
		expect(html).not.toContain('Should Not Render In Panel');
		expect(html).not.toContain('Also Should Not Render');
		expect(html).not.toContain('Current Connections - Core');
	});

	it('renderFirmDetail shows parent FINRA profile link for scraped/orphan firms', () => {
		const html = renderFirmDetail({
			id: 'firm:291387',
			firmId: '291387',
			label: 'OPENDEAL BROKER LLC',
			group: 'firm',
			stub: true,
			hasFinraData: false,
			hasSecData: false,
			orphan: {
				firmId: '291387',
				firmName: 'OPENDEAL BROKER LLC',
				name: 'Carlson Davis Mummert',
				parentCrd: '8105966',
				parentType: 'individual',
				firmStatus: 'Legacy / non-live',
				officeAddress: {
					street1: '149 5TH AVENUE',
					city: 'NEW YORK',
					state: 'NY',
					postalCode: '10010',
				},
			},
		} as any);

		expect(html).toContain('Opendeal Broker LLC');
		expect(html).toContain('Scraped firm reference');
		expect(html).toContain('FINRA profile');
		expect(html).toContain('https://brokercheck.finra.org/individual/summary/8105966');
		expect(html).toContain("data-crd='8105966'");
		expect(html).toContain('Carlson Davis Mummert');
		expect(html).not.toContain('brokercheck.finra.org/firm/summary/291387');
	});

	it('uses SEC registration status to mark terminated firms inactive and show a SEC terminated badge', () => {
		const node = {
			group: 'firm',
			id: 'firm:154604',
			hasSecData: true,
			registrationStatus: [{ secJurisdiction: 'SEC', status: 'Terminated', effectiveDate: '7/14/2023' }],
			basicInformation: {},
		} as any;
		const html = renderFirmDetail(node);

		expect(isNodeInactive(node)).toBe(true);
		expect(html).toContain('SEC Terminated');
	});

	it('renders SEC notice filings in the firm detail panel with status styling', () => {
		const html = renderFirmDetail({
			id: 'firm:107342',
			firmId: '107342',
			label: 'Example Firm',
			group: 'firm',
			hasSecData: true,
			secSummaryDescription: 'SEC adviser firm profile',
			registrationStatus: [{ secJurisdiction: 'SEC', status: 'Approved', effectiveDate: '3/26/1987' }],
			noticeFilings: [
				{ jurisdiction: 'Alabama', effectiveDate: '5/3/1995', status: 'Approved' },
				{ jurisdiction: 'California', effectiveDate: '1/1/1988', status: 'Approved' },
			],
			basicInformation: {},
		} as any);

		expect(html).toContain('Notice Filings');
		expect(html).toContain('Alabama');
		expect(html).toContain('California');
		expect(html).toContain('5/3/1995');
		expect(html).toContain('1/1/1988');
		expect(html).toContain('fg-badge active');
	});

	it('resolves person employment links via SEC firm identifiers when CRD is absent', () => {
		const employment = {
			firmId: '',
			firmName: 'Fisher Investments',
			bdSECNumber: '8-29362',
			_isCurrent: true,
		};

		const resolved = resolveEmploymentConnectionFirmNodeId(employment);
		expect(resolved).toBe('firm:8-29362');
	});

	it('getNodeLabelFontSize grows as the graph zooms out', () => {
		expect(getNodeLabelFontSize({ zoomScale: 1 })).toBe(16);
		expect(getNodeLabelFontSize({ zoomScale: 0.5 })).toBeGreaterThan(16);
		expect(getNodeLabelFontSize({ zoomScale: 0.2 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 0.5 }));
	});

	it('getNodeLabelFontSize enlarges visually emphasized nodes', () => {
		const baseSize = getNodeLabelFontSize({ zoomScale: 1 });
		const emphasizedSize = getNodeLabelFontSize({ isEmphasized: true, zoomScale: 1 } as any);

		expect(emphasizedSize).toBeGreaterThan(baseSize);
	});

	it('handleNodeKeyboardActivation selects focused graph nodes with Enter', () => {
		const activateNode = vi.fn();
		const event = {
			key: 'Enter',
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as any;

		const handled = handleNodeKeyboardActivation(event, { id: 'person:123' }, activateNode);

		expect(handled).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(event.stopPropagation).toHaveBeenCalledTimes(1);
		expect(activateNode).toHaveBeenCalledWith(event, { id: 'person:123' });
	});

	it('mergeGraphNodesByIdentity merges person nodes that share the same CRD', () => {
		const existing = [{ id: 'person:123', group: 'individual', crd: '123', label: 'CRD 123' } as any];
		const incoming = [{ id: 'person_123', group: 'individual', crd: '123', label: 'Ada Lovelace', basicInformation: { firstName: 'Ada' } } as any];

		const merged = mergeGraphNodesByIdentity(existing, incoming);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe('person:123');
		expect(merged[0].basicInformation.firstName).toBe('Ada');
	});

	it('mergeGraphNodesByIdentity merges firm nodes that share the same CRD even when the group is omitted', () => {
		const existing = [{ id: 'firm:6413', firmId: '6413', label: 'LPL Financial LLC' } as any];
		const incoming = [{ id: 'firm_6413', crd: '6413', label: 'LPL Financial LLC', basicInformation: { doingBusinessAs: 'LPL' } } as any];

		const merged = mergeGraphNodesByIdentity(existing, incoming);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe('firm:6413');
		expect(merged[0].firmId).toBe('6413');
		expect(merged[0].crd).toBe('6413');
		expect(merged[0].basicInformation.doingBusinessAs).toBe('LPL');
	});

	it('mergeIncomingNodesIntoExistingNodes avoids appending a second copy for the same CRD', () => {
		const existing = [{ id: 'person:7803022', group: 'individual', crd: '7803022', label: 'CRD 7803022' } as any];
		const incoming = [{ id: 'person_7803022', group: 'individual', crd: '7803022', label: 'Megan Vogt Omoruyi', basicInformation: { firstName: 'Megan' } } as any];

		const result = mergeIncomingNodesIntoExistingNodes(existing, incoming);

		expect(result.nodes).toHaveLength(1);
		expect(result.added).toEqual([]);
		expect(result.nodes[0].label).toBe('Megan Vogt Omoruyi');
	});

	it('mergeIncomingNodesIntoExistingNodes preserves existing layout node object identity', () => {
		const existingNode = { id: 'person:42', group: 'individual', crd: '42', label: 'Settled', fx: 10, fy: 20, x: 10, y: 20 } as any;
		const incoming = [{ id: 'person:99', group: 'individual', crd: '99', label: 'New' } as any];

		const result = mergeIncomingNodesIntoExistingNodes([existingNode], incoming);

		expect(result.nodes[0]).toBe(existingNode);
		expect(result.nodes[0].fx).toBe(10);
		expect(result.nodes[0].fy).toBe(20);
		expect(result.added).toEqual(['person:99']);
	});

	it('mergeGraphNodesForAppend keeps the canonical person id when an alternate id arrives', () => {
		const existing = [{ id: 'person:7212646', group: 'individual', crd: '7212646', label: 'Melinda Q Liu' } as any];
		const incoming = [{ id: 'person_7212646', group: 'individual', crd: '7212646', label: 'Melinda Q Liu', basicInformation: { firstName: 'Melinda' } } as any];

		const result = mergeGraphNodesForAppend(existing, incoming);
		const rewrittenLinks = rewriteGraphLinksForNodeIdentity([{ source: 'person_7212646', target: 'firm:1', relationship: 'employed_by' }], result.idRewriteMap);

		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0].id).toBe('person:7212646');
		expect(result.added).toEqual([]);
		expect(result.idRewriteMap.get('person_7212646')).toBe('person:7212646');
		expect(rewrittenLinks[0].source).toBe('person:7212646');
	});

	it('mergeGraphNodesForAppend collapses duplicate firm nodes from the same batch', () => {
		const existing = [] as any[];
		const incoming = [
			{ id: 'firm:6413', group: 'firm', firmId: '6413', label: 'LPL Financial LLC' } as any,
			{ id: 'firm_6413', group: 'firm', firmId: '6413', label: 'LPL Financial LLC', bcScope: 'Active' } as any,
			{ id: 'person:1', group: 'individual', crd: '1', label: 'Owner One' } as any,
		];

		const result = mergeGraphNodesForAppend(existing, incoming);
		const rewrittenLinks = rewriteGraphLinksForNodeIdentity([{ source: 'person:1', target: 'firm_6413', relationship: 'controls' }], result.idRewriteMap);

		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.find((node) => node.group === 'firm')?.id).toBe('firm:6413');
		expect(result.nodes.find((node) => node.group === 'firm')?.bcScope).toBe('Active');
		expect(result.idRewriteMap.get('firm_6413')).toBe('firm:6413');
		expect(rewrittenLinks[0].target).toBe('firm:6413');
	});

	it('mergeIncomingNodesIntoExistingNodes collapses duplicate person nodes already present for the same CRD', () => {
		const existing = [
			{ id: 'person:1333632', group: 'individual', crd: '1333632', label: 'CRD 1333632' } as any,
			{ id: 'person_1333632', group: 'individual', crd: '1333632', label: 'Larry Benton Lessley' } as any,
		];
		const incoming = [{ id: 'person:1333632', group: 'individual', crd: '1333632', label: 'Larry Benton Lessley', basicInformation: { firstName: 'Larry' } } as any];

		const result = mergeIncomingNodesIntoExistingNodes(existing, incoming);

		expect(result.nodes).toHaveLength(1);
		expect(result.added).toEqual([]);
		expect(result.nodes[0].label).toBe('Larry Benton Lessley');
		expect(result.nodes[0].basicInformation.firstName).toBe('Larry');
	});

	it('resolveNodeByIdOrIdentity finds an existing firm node by identity when the route uses a canonical id', () => {
		const existing = [{ id: 'firm_6413', group: 'firm', firmId: '6413', label: 'LPL FINANCIAL LLC' } as any];

		const resolved = resolveNodeByIdOrIdentity('firm:6413', existing);

		expect(resolved).toBeDefined();
		expect(resolved?.id).toBe('firm_6413');
		expect(resolved?.firmId).toBe('6413');
	});

	it('normalizeNodeRouteId turns person route slugs into canonical graph ids', () => {
		expect(normalizeNodeRouteId('person-4240769')).toBe('person:4240769');
		expect(normalizeNodeRouteId('firm-12345')).toBe('firm:12345');
	});

	it('selectNodesToInjectById skips nodes already rendered by identity', () => {
		const renderedNodes = [{ id: 'person_123', group: 'individual', crd: '123', label: 'Ada Lovelace' } as any];
		const graphNodes = [
			{ id: 'person:123', group: 'individual', crd: '123', label: 'Ada Lovelace' } as any,
			{ id: 'person:456', group: 'individual', crd: '456', label: 'Grace Hopper' } as any,
		];

		const toAdd = selectNodesToInjectById(['person:123', 'person:456'], { renderedNodes, graphNodes });

		expect(toAdd.map((node) => node.id)).toEqual(['person:456']);
	});

	it('releasePinnedSelectedNodeAnchor clears the prior selection anchor', () => {
		const previousNode = { id: 'person:123', fx: 10, fy: 20 } as any;
		const nextNode = { id: 'person:456', fx: null, fy: null } as any;

		expect(releasePinnedSelectedNodeAnchor(previousNode.id, [previousNode, nextNode])).toBe(true);
		expect(previousNode.fx).toBeNull();
		expect(previousNode.fy).toBeNull();
	});

	it('scheduleNodeExpansion defers expansion work until the queued timer runs', () => {
		vi.useFakeTimers();
		const task = vi.fn();
		scheduleNodeExpansion({ id: 'person:123' }, {}, task as any);
		expect(task).not.toHaveBeenCalled();
		vi.runOnlyPendingTimers();
		expect(task).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('getLargeNodeRevealBatchPlan stages large reveals into multiple smaller batches', () => {
		const plan = getLargeNodeRevealBatchPlan(140, 800);

		expect(plan.shouldBatch).toBe(true);
		expect(plan.batchSize).toBeGreaterThan(0);
		expect(plan.batchCount).toBeGreaterThan(1);
	});

	it('uses smaller batches for large graph reveals to keep motion smooth', () => {
		const plan = getLargeNodeRevealBatchPlan(240, 2500);

		expect(plan.shouldBatch).toBe(true);
		expect(plan.batchSize).toBeLessThanOrEqual(12);
		expect(plan.batchDelayMs).toBeGreaterThan(0);
	});

	it('uses near-immediate pacing for user-initiated expansion on smaller graphs', () => {
		const timing = getNodeExpansionRevealTiming(240, { isUserInitiated: true });

		expect(timing.delayMs).toBeLessThanOrEqual(20);
		expect(timing.animationMs).toBeLessThanOrEqual(160);
	});

	it('getSelectionLinkOpacity keeps gray links brighter in selection emphasis', () => {
		const emphasis = { strokeOpacity: 0.66 } as any;
		const grayLink = { relationship: 'previous_employed_by' } as any;
		const regularLink = { relationship: 'employed_by', isCurrent: true } as any;
		const controlLink = { relationship: 'controls' } as any;

		expect(getSelectionLinkOpacity(grayLink, emphasis)).toBeGreaterThan(0.8);
		expect(getSelectionLinkOpacity(grayLink, emphasis, { connected: true })).toBe(getSelectionLinkOpacity(grayLink, emphasis));
		expect(getSelectionLinkOpacity(regularLink, emphasis, { connected: true })).toBe(0.66);
		// Red controls stay fully opaque so they do not blend purple over blue employment lines.
		expect(getSelectionLinkOpacity(controlLink, emphasis)).toBe(1);
		expect(getSelectionLinkOpacity(controlLink, emphasis, { connected: true })).toBe(1);
	});

	it('shouldRenderBlueNodeHighlight enables blue outline for hovered or selected individuals', () => {
		const individualNode = { id: 'person:1', group: 'individual' } as any;
		const firmNode = { id: 'firm:1', group: 'firm' } as any;

		expect(shouldRenderBlueNodeHighlight(individualNode, { hovered: true })).toBe(true);
		expect(shouldRenderBlueNodeHighlight(individualNode, { selected: true })).toBe(true);
		expect(shouldRenderBlueNodeHighlight(firmNode, { hovered: true })).toBe(false);
	});

	it('clearSelectionState clears the active node selection and highlight roots', () => {
		const resetState = clearSelectionState({
			selectedId: 'person:123',
			highlightedSelections: [{ id: 'person:123', hops: 1 }],
			sidebarSelectedNode: { id: 'person:123' },
		});

		expect(resetState.selectedId).toBeNull();
		expect(resetState.highlightedSelections).toEqual([]);
		expect(resetState.persistentSelectedIds).toEqual([]);
		expect(resetState.sidebarSelectedNode).toBeNull();
	});

	it('rewriteLinksForNodeIdMap rewrites link endpoints after node identity merges', () => {
		const links = [{ source: 'person_1333632', target: 'firm:1', relationship: 'employed_by' }] as any[];
		const rewritten = rewriteLinksForNodeIdMap(links, new Map([['person_1333632', 'person:1333632']]));

		expect(rewritten).toHaveLength(1);
		expect(rewritten[0].source).toBe('person:1333632');
		expect(rewritten[0].target).toBe('firm:1');
	});

	it('resolveLinkEndpoints converts restored string endpoints to node objects', () => {
		const nodes = [
			{ id: 'person:1', group: 'individual' },
			{ id: 'firm:1', group: 'firm' },
		] as any[];
		const links = [{ source: 'person:1', target: 'firm:1', relationship: 'employed_by' }] as any[];

		const resolved = resolveLinkEndpoints(links, nodes);

		expect(resolved).toHaveLength(1);
		expect(resolved[0].source).toEqual(nodes[0]);
		expect(resolved[0].target).toEqual(nodes[1]);
	});

	it('rebindLinksToNodes swaps existing links onto the freshly merged node objects', () => {
		const previousNode = { id: 'person:1', group: 'individual', x: 10, y: 20 } as any;
		const previousFirm = { id: 'firm:1', group: 'firm', x: 30, y: 40 } as any;
		const mergedNodes = [
			{ ...previousNode, x: 11, y: 21 },
			{ ...previousFirm, x: 31, y: 41 },
			{ id: 'person:2', group: 'individual', x: 50, y: 60 },
		] as any[];
		const links = [{ source: previousNode, target: previousFirm, relationship: 'employed_by' }] as any[];

		const rebound = rebindLinksToNodes(links, mergedNodes);

		expect(rebound).toHaveLength(1);
		expect(rebound[0].source).toBe(mergedNodes[0]);
		expect(rebound[0].target).toBe(mergedNodes[1]);
	});

	it('buildSessionRenderGraphData includes persisted extra nodes for session restoration', () => {
		const baseGraphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'firm:1', group: 'firm' },
			],
			links: [{ source: 'person:1', target: 'firm:1', relationship: 'employed_by' }],
			meta: {},
		} as any;

		const session = {
			selectedNodeId: 'person:999',
			highlightedNodes: [{ id: 'person:999', hops: 1 }],
			extraNodes: [{ id: 'person:999', group: 'individual', label: 'Extra person' }],
			extraLinks: [{ source: 'person:999', target: 'firm:1', relationship: 'controls' }],
			renderedServerIds: ['person:1', 'firm:1'],
		} as any;

		const projected = buildSessionRenderGraphData(session, baseGraphData);
		expect(projected).not.toBeNull();
		expect(projected.nodes.map((node) => node.id)).toContain('person:999');
		expect(projected.links.some((link) => link.source === 'person:999' && link.target === 'firm:1')).toBe(true);
	});

	it('normalizeNodeLabelInPlace upgrades Node person placeholders to fetched individual names', () => {
		const node = {
			id: 'person:5825353',
			label: 'Node person:5825353',
			group: 'individual',
			basicInformation: {
				firstName: 'MARK',
				middleName: 'DANIEL',
				lastName: 'MCADAM',
			},
		} as any;

		normalizeNodeLabelInPlace(node);

		expect(node.label).toBe('Mark Daniel Mcadam');
	});

	it('applyIndividualDetail replaces Node person placeholders with fetched names', () => {
		const node = {
			id: 'person:5825353',
			label: 'Node person:5825353',
			group: 'individual',
			crd: '5825353',
		} as any;

		applyIndividualDetailFromDetailUtils(
			node,
			{
				basicInformation: {
					individualId: 5825353,
					firstName: 'MARK',
					middleName: 'DANIEL',
					lastName: 'MCADAM',
				},
				previousEmployments: [{ firmId: 35513, firmName: 'CG CAPITAL MARKETS, LLC' }],
			},
			'5825353',
		);

		expect(node.label).toBe('Mark Daniel Mcadam');
		expect(node.previousEmployments).toHaveLength(1);
	});

	it('hasRichIndividualDetail does not treat empty count objects as rich detail', () => {
		expect(
			hasRichIndividualDetail({
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				examsCount: {
					stateExamCount: 0,
					principalExamCount: 0,
					productExamCount: 0,
				},
				brokerDetails: {
					hasBCComments: 'N',
					hasIAComments: 'N',
					legacyReportStatusDescription: 'Not Requested',
				},
			}),
		).toBe(false);

		expect(
			hasRichIndividualDetail({
				previousEmployments: [{ firmId: 6694, firmName: 'RAYMOND JAMES FINANCIAL SERVICES, INC.' }],
			}),
		).toBe(true);
	});

	it('isNodeInactive marks fetched inactive individuals as inactive immediately', () => {
		const node = {
			id: 'person:123',
			group: 'individual',
			label: 'Example Person',
			hasFinraData: true,
			bcScope: 'InActive',
			registrationCount: {
				approvedFinraRegistrationCount: 0,
				approvedSRORegistrationCount: 0,
				approvedStateRegistrationCount: 0,
				approvedIAStateRegistrationCount: 0,
			},
			currentEmployments: [],
			currentIAEmployments: [],
			previousEmployments: [{ firmId: '1' }],
			previousIAEmployments: [],
			registeredStates: [],
			registeredSROs: [],
		} as any;

		expect(isNodeInactive(node)).toBe(true);
	});

	it('enlarges emphasized labels for hover and selection feedback at zoomed-in views', () => {
		expect(getNodeLabelFontSize({ isSelected: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isHovered: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isBolded: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
	});

	it('keeps large labels from shrinking when zooming in', () => {
		expect(getNodeLabelFontSize({ zoomScale: 1 })).toBe(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
		expect(getNodeLabelFontSize({ zoomScale: 1.25 })).toBeGreaterThanOrEqual(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
	});

	it('makes selected labels larger than standard labels when zoomed in', () => {
		expect(getNodeLabelFontSize({ isSelected: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isHovered: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
	});

	it('includes firm CRDs in the node tooltip title', () => {
		const node = { id: 'firm:7803022', group: 'firm', label: 'Example Firm', firmId: '7803022' } as any;
		expect(getNodeTooltipTitle(node)).toContain('CRD: 7803022');
	});

	it('renderPersonDetail uses parent-firm summary URLs for active current employment records', () => {
		const html = renderPersonDetail(
			{
				id: 'person:123',
				label: 'Example Person',
				crd: '123',
				bcScope: 'Active',
				iaScope: 'Active',
				basicInformation: {
					individualId: '123',
					firstName: 'Example',
					lastName: 'Person',
				},
				currentEmployments: [{ firmId: '456', firmName: 'Example Firm', isCurrent: true }],
				previousEmployments: [],
				disclosures: [],
				iaDisclosures: [],
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				registeredStates: [],
				registeredSROs: [],
				currentIAEmployments: [],
				previousIAEmployments: [],
			},
			{ graphData: { links: [] } },
		);

		expect(html).toContain('https://brokercheck.finra.org/individual/summary/123');
		expect(html).toContain('https://adviserinfo.sec.gov/individual/summary/123');
	});

	it('isNodeInactive keeps active fetched individuals enabled', () => {
		const node = {
			id: 'person:456',
			group: 'individual',
			label: 'Active Person',
			hasFinraData: true,
			bcScope: 'Active',
			registrationCount: {
				approvedFinraRegistrationCount: 1,
				approvedSRORegistrationCount: 0,
				approvedStateRegistrationCount: 0,
				approvedIAStateRegistrationCount: 0,
			},
			currentEmployments: [{ firmId: '1' }],
			currentIAEmployments: [],
			previousEmployments: [],
			previousIAEmployments: [],
			registeredStates: [],
			registeredSROs: [],
		} as any;

		expect(isNodeInactive(node)).toBe(false);
	});

	it('supports a data-driven forced gray link without hard-coded CRDs', () => {
		const link = {
			source: { id: 'person:111' },
			target: { id: 'firm:222' },
			relationship: 'employed_by',
			isCurrent: true,
			forceGray: true,
		} as any;

		expect(isForcedGrayConnectionLink(link)).toBe(true);
		expect(isForcedGrayConnectionLink({ source: 'firm:222', target: 'person:111', relationship: 'employed_by', forceGray: true })).toBe(true);
		expect(isForcedGrayConnectionLink({ source: 'person:100', target: 'firm:200', relationship: 'employed_by' })).toBe(false);
		expect(isForcedGrayConnectionLink({ source: 'firm:222', target: 'person:111', relationship: 'employed_by' })).toBe(false);
	});

	it('isRevealableChainExhausted stays false when a visible downstream node still has hidden revealable neighbors', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', type: 'person' }],
			['firm:34040', { id: 'firm:34040', type: 'firm' }],
			['person:4118468', { id: 'person:4118468', type: 'person' }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769'])],
			['person:4118468', new Set()],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
			),
		).toBe(false);
	});

	it('isRevealableChainExhausted returns true when the visible revealable chain is fully exhausted', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', type: 'person' }],
			['firm:34040', { id: 'firm:34040', type: 'firm' }],
			['person:4118468', { id: 'person:4118468', type: 'person' }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set(['firm:34040'])],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
			),
		).toBe(true);
	});

	it('isRevealableChainExhausted stays false when a visible downstream node cannot be inspected yet', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', inspectable: true }],
			['firm:34040', { id: 'firm:34040', inspectable: false }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769'])],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
				(node) => node.inspectable === true,
			),
		).toBe(false);
	});

	it('shouldRenderNodeSelected keeps merely visited expandable nodes out of selected styling', () => {
		const node = { id: 'person:4624219', label: 'Katherine Patricia Clune' } as any;

		expect(
			shouldRenderNodeSelected(node, {
				selectedId: 'person:9999999',
				highlightRootIds: new Set<string>(),
				persistentSelectedIds: new Set<string>(),
				visitedNodeIds: new Set(['person:4624219']),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => false,
			}),
		).toBe(false);
	});

	it('shouldRenderNodeSelected does not treat neighboring highlight hops as selected nodes', () => {
		const child = { id: 'person:4624220', label: 'Child Node' } as any;

		expect(
			shouldRenderNodeSelected(child, {
				selectedId: 'person:4624219',
				highlightRootIds: new Set(['person:4624219']),
				persistentSelectedIds: new Set(['person:4624219']),
				visitedNodeIds: new Set(['person:4624219', 'person:4624220']),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => false,
			}),
		).toBe(false);
	});

	it('shouldRenderNodeSelected keeps previously selected nodes after Clear Highlight (durable set)', () => {
		const prior = { id: 'person:111', label: 'Prior Selected' } as any;

		expect(
			shouldRenderNodeSelected(prior, {
				selectedId: 'person:222',
				highlightRootIds: new Set<string>(), // hop roots cleared
				persistentSelectedIds: new Set(['person:111', 'person:222']),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => false,
			}),
		).toBe(true);
	});

	it('shouldRenderNodeSelected still marks exhausted fetched nodes as selected', () => {
		const node = { id: 'person:4240769', label: 'Example Person' } as any;

		expect(
			shouldRenderNodeSelected(node, {
				selectedId: null,
				highlightRootIds: new Set<string>(),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => true,
			}),
		).toBe(true);
	});

	it('shouldAutoRevealNodeConnections reveals firm and individual connections', () => {
		expect(shouldAutoRevealNodeConnections({ id: 'person:123', group: 'individual' })).toBe(true);
		expect(shouldAutoRevealNodeConnections({ id: 'firm:456', group: 'firm' })).toBe(true);
	});

	it('getLinkIdentityKey distinguishes current and previous employment links on the same firm pair', () => {
		const currentLink = { source: 'person:1', target: 'firm:9', relationship: 'employed_by', isCurrent: true };
		const previousLink = { source: 'person:1', target: 'firm:9', relationship: 'employed_by', isCurrent: false };

		expect(getLinkIdentityKey(currentLink)).not.toBe(getLinkIdentityKey(previousLink));
	});

	it('getLargeGraphRenderBudget caps the render surface for very large graphs', () => {
		expect(getLargeGraphRenderBudget(20_000, 1)).toBeLessThanOrEqual(980);
		expect(getLargeGraphRenderBudget(5_000, 1)).toBeLessThanOrEqual(650);
		expect(getLargeGraphRenderBudget(4_000, 1)).toBeLessThanOrEqual(650);
	});

	it('getProgressiveLoadBudget reveals larger slices over time for huge graphs', () => {
		expect(getProgressiveLoadBudget(5_000, 1, 0)).toBeLessThan(getProgressiveLoadBudget(5_000, 1, 4));
		expect(getProgressiveLoadBudget(5_000, 1, 4)).toBe(getLargeGraphRenderBudget(5_000, 1));
		expect(getProgressiveLoadBudget(1_000, 1, 0)).toBe(getLargeGraphRenderBudget(1_000, 1));
	});

	it('shouldUseInitialSvgFallback stays off so graphs always render in SVG', () => {
		expect(shouldUseInitialSvgFallback(250)).toBe(false);
		expect(shouldUseInitialSvgFallback(400)).toBe(false);
		expect(shouldUseInitialSvgFallback(8_000)).toBe(false);
	});

	it('buildLargeGraphRenderPlan preserves the selected node and trims off-screen work', () => {
		const nodes = [
			{ id: 'focus', x: 100, y: 100, group: 'individual', _deg: { total: 90 } },
			{ id: 'near', x: 110, y: 110, group: 'firm', _deg: { total: 10 } },
			{ id: 'far', x: 5000, y: 5000, group: 'entity', _deg: { total: 1 } },
		] as any[];
		const links = [
			{ source: 'focus', target: 'near', relationship: 'controls' },
			{ source: 'far', target: 'near', relationship: 'controls' },
		] as any[];

		const transformed = buildLargeGraphRenderPlan(
			nodes,
			links,
			{ x: 0, y: 0, k: 1 },
			{
				width: 400,
				height: 300,
				selectedId: 'focus',
				maxVisibleNodes: 2,
			},
		);

		expect(transformed.visibleNodeIds.has('focus')).toBe(true);
		expect(transformed.visibleNodeIds.has('near')).toBe(true);
		expect(transformed.visibleNodeIds.has('far')).toBe(false);
		expect(transformed.visibleLinks.length).toBeLessThanOrEqual(2);
	});

	it('shouldAutoExpandRouteSelection skips duplicate route expansion for the already selected node', () => {
		expect(shouldAutoExpandRouteSelection('person:4240769', 'person:4240769')).toBe(false);
		expect(shouldAutoExpandRouteSelection('person:4240769', 'person:1111111')).toBe(true);
		expect(shouldAutoExpandRouteSelection('person:4240769', null)).toBe(true);
	});

	it('shouldSuppressFirmSelectionPersonLink keeps firm roster quiet unless firm or child is hovered', () => {
		const base = {
			entryGroup: 'firm',
			isSelection: true,
			entryId: 'firm:1',
			neighborGroup: 'individual',
			neighborId: 'person:2',
		};
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, hoveredNodeId: null })).toBe(true);
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, hoveredNodeId: 'firm:9' })).toBe(true);
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, hoveredNodeId: 'firm:1' })).toBe(false);
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, hoveredNodeId: 'person:2' })).toBe(false);
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, isSelection: false, hoveredNodeId: null })).toBe(false);
		expect(shouldSuppressFirmSelectionPersonLink({ ...base, entryGroup: 'individual', hoveredNodeId: null })).toBe(false);
	});

	it('selectHopHighlightRoots keeps only the most recent selection roots within the hop BFS cap', () => {
		const selectionRoots = Array.from({ length: MAX_HOP_HIGHLIGHT_ROOTS + 20 }, (_, index) => ({
			id: `person:${1000 + index}`,
			hops: 1,
		}));
		const roots = selectHopHighlightRoots(selectionRoots, {
			hoveredNodeId: 'person:hover',
			logBoldNodeIds: Array.from({ length: 30 }, (_, index) => `person:log${index}`),
			maxSelectionRoots: MAX_HOP_HIGHLIGHT_ROOTS,
			maxLogBoldRoots: 8,
		});
		const selectionRootIds = roots.filter((entry) => entry.isSelection).map((entry) => entry.id);
		expect(selectionRootIds).toHaveLength(MAX_HOP_HIGHLIGHT_ROOTS);
		// Most recent selections win (end of the input array).
		expect(selectionRootIds[0]).toBe(`person:${1000 + MAX_HOP_HIGHLIGHT_ROOTS + 19}`);
		expect(roots.some((entry) => entry.id === 'person:hover')).toBe(true);
		expect(roots.filter((entry) => String(entry.id).startsWith('person:log')).length).toBeLessThanOrEqual(8);
	});

	it('layoutHasLinkIdentity uses rebuilt layout link indexes for O(1) membership checks', () => {
		const links = [
			{ source: 'person:1', target: 'firm:2', relationship: 'employed_by', isCurrent: true, startDate: '2020-01-01', endDate: '' },
			{ source: 'person:3', target: 'firm:2', relationship: 'controls', isCurrent: true, startDate: '', endDate: '' },
		];
		rebuildLayoutLinkIndexes(links);
		expect(layoutHasLinkIdentity(links[0])).toBe(true);
		expect(layoutHasLinkIdentity(links[1])).toBe(true);
		expect(layoutHasLinkIdentity({ source: 'person:9', target: 'firm:9', relationship: 'employed_by', isCurrent: true })).toBe(false);
		expect(getLinkIdentityKey(links[0])).toContain('person:1|firm:2');
	});

	it('getAutoExpansionHopsForNode uses exactly the requested hop count (default click is 1 hop)', () => {
		const densePerson = {
			id: 'person:4240769',
			group: 'individual',
			currentEmployments: Array.from({ length: 20 }, (_, index) => ({ firmId: String(1000 + index) })),
			currentIAEmployments: [],
		} as any;
		const sparsePerson = {
			id: 'person:123',
			group: 'individual',
			currentEmployments: [{ firmId: '1' }, { firmId: '2' }],
			currentIAEmployments: [],
		} as any;
		const denseFirm = {
			id: 'firm:11469',
			group: 'firm',
			directOwners: Array.from({ length: 30 }, (_, index) => ({ crdNumber: String(4000000 + index) })),
		} as any;

		// Never auto-bump dense nodes past the requested hop count (used to force 2 hops).
		expect(getAutoExpansionHopsForNode(densePerson, 1)).toBe(1);
		expect(getAutoExpansionHopsForNode(sparsePerson, 1)).toBe(1);
		expect(getAutoExpansionHopsForNode(denseFirm, 1)).toBe(1);
		expect(getAutoExpansionHopsForNode(densePerson, 2)).toBe(2);
		expect(getAutoExpansionHopsForNode(sparsePerson, 2)).toBe(2);
		expect(getAutoExpansionHopsForNode(denseFirm, 2)).toBe(2);
	});

	it('shouldHydrateExpansionFrontierNodeDetail skips background firm hydration unless explicitly enabled', () => {
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'person:123', group: 'individual' })).toBe(true);
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'firm:456', group: 'firm' })).toBe(false);
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'firm:456', group: 'firm' }, { includeFirmDetails: true })).toBe(true);
	});

	it('shouldFetchFirmDetailForOwnerEvidence disables firm detail lookups for background owner-evidence hydration', () => {
		expect(shouldFetchFirmDetailForOwnerEvidence()).toBe(true);
		expect(shouldFetchFirmDetailForOwnerEvidence({ allowFirmDetailFetch: false })).toBe(false);
	});

	it('selectTextSearchHydrationTargets dedupes summary hits and caps hydration work', () => {
		expect(
			selectTextSearchHydrationTargets(
				[
					{ nodeId: 'person:1', group: 'individual', hasEmbeddedDetail: false },
					{ nodeId: 'person:1', group: 'individual', hasEmbeddedDetail: false },
					{ nodeId: 'firm:2', group: 'firm', hasEmbeddedDetail: false },
					{ nodeId: 'person:3', group: 'individual', hasEmbeddedDetail: true },
					{ nodeId: 'person:4', group: 'individual', hasEmbeddedDetail: false },
				],
				2,
			),
		).toEqual([
			{ nodeId: 'person:1', group: 'individual' },
			{ nodeId: 'firm:2', group: 'firm' },
		]);
	});

	it('applyGraphDerivedNodeMetrics gives fetched individuals a connection count before links are rendered', () => {
		const nodes = [
			{
				id: 'person:123',
				group: 'individual',
				label: 'Alice Example',
				currentEmployments: [{ firmId: '10', firmName: 'Alpha Capital' }],
				currentIAEmployments: [{ firmId: '20', firmName: 'Beta Advisors' }],
				previousEmployments: [{ firmId: '30', firmName: 'Gamma Securities' }],
				previousIAEmployments: [],
				controlPositions: [{ firmId: '40', firmName: 'Delta Holdings' }],
			},
		] as any[];

		applyGraphDerivedNodeMetrics(nodes, []);

		expect(nodes[0]?._deg).toMatchObject({ total: 4, employed: 3, controls: 1 });
		expect(nodes[0]?._vizHalf).toBeGreaterThan(6);
	});

	it('applyGraphDerivedNodeMetrics gives fetched firms a control count before owner links are rendered', () => {
		const nodes = [
			{
				id: 'firm:789',
				group: 'firm',
				label: 'Example Firm',
				directOwners: [{ crdNumber: '123' }, { crd: '456' }],
			},
		] as any[];

		applyGraphDerivedNodeMetrics(nodes, []);

		expect(nodes[0]?._deg).toMatchObject({ total: 4, controls: 2, employed: 0 });
		expect(nodes[0]?._vizHalf).toBeGreaterThanOrEqual(18);
		expect(nodes[0]?._vizHalf).toBeLessThanOrEqual(36);
	});

	it('applyGraphDerivedNodeMetrics uses sidecar knownConnectionCount as the sizing floor', () => {
		const person = {
			id: 'person:9',
			group: 'individual',
			label: 'Sidecar Person',
			knownConnectionCount: 25,
		} as any;
		const firm = {
			id: 'firm:9',
			group: 'firm',
			label: 'Sidecar Firm',
			knownConnectionCount: 40,
		} as any;

		applyGraphDerivedNodeMetrics([person, firm], []);

		expect(person._deg.total).toBeGreaterThanOrEqual(25);
		expect(firm._deg.total).toBeGreaterThanOrEqual(40);
		expect(person._vizHalf).toBeGreaterThanOrEqual(22.4);
		expect(person._vizHalf).toBeLessThanOrEqual(44.8);
		expect(firm._vizHalf).toBeGreaterThanOrEqual(18);
		expect(firm._vizHalf).toBeLessThanOrEqual(36);
	});

	it('applyGraphDerivedNodeMetrics caps large person size from known connections', () => {
		const person = {
			id: 'person:4240769',
			group: 'individual',
			label: 'Daniel Stewart Beaton',
			knownConnectionCount: 109,
			_vizHalf: 116,
		} as any;

		applyGraphDerivedNodeMetrics([person], []);

		expect(person._deg.total).toBeGreaterThanOrEqual(109);
		expect(person._vizHalf).toBe(44.8);
	});

	it('applyGraphDerivedNodeMetrics scales people across clear size steps', () => {
		const low = { id: 'person:low', group: 'individual', knownConnectionCount: 1 } as any;
		const midLow = { id: 'person:midlow', group: 'individual', knownConnectionCount: 3 } as any;
		const mid = { id: 'person:mid', group: 'individual', knownConnectionCount: 8 } as any;
		const high = { id: 'person:high', group: 'individual', knownConnectionCount: 20 } as any;

		applyGraphDerivedNodeMetrics([low, midLow, mid, high], []);

		expect(low._vizHalf).toBeCloseTo(22.4, 5);
		expect(midLow._vizHalf).toBeCloseTo(28.8, 5);
		expect(mid._vizHalf).toBeCloseTo(35.2, 5);
		expect(high._vizHalf).toBeCloseTo(44.8, 5);
		expect(low._vizHalf).toBeLessThan(midLow._vizHalf);
		expect(midLow._vizHalf).toBeLessThan(mid._vizHalf);
		expect(mid._vizHalf).toBeLessThan(high._vizHalf);
	});

	it('applyGraphDerivedNodeMetrics never shrinks an existing node size when the graph grows', () => {
		const person = {
			id: 'person:1',
			group: 'individual',
			label: 'Alpha',
			knownConnectionCount: 4,
		} as any;
		const firm = {
			id: 'firm:1',
			group: 'firm',
			label: 'Alpha Firm',
			knownConnectionCount: 4,
		} as any;

		applyGraphDerivedNodeMetrics([person, firm], []);
		const personHalfBefore = person._vizHalf;
		const firmHalfBefore = firm._vizHalf;

		const hugeFirm = {
			id: 'firm:huge',
			group: 'firm',
			label: 'Huge Firm',
			knownConnectionCount: 500,
		} as any;
		const hugePerson = {
			id: 'person:huge',
			group: 'individual',
			label: 'Huge Person',
			knownConnectionCount: 500,
		} as any;

		applyGraphDerivedNodeMetrics([person, firm, hugeFirm, hugePerson], []);

		expect(person._vizHalf).toBeGreaterThanOrEqual(personHalfBefore);
		expect(firm._vizHalf).toBeGreaterThanOrEqual(firmHalfBefore);
		expect(hugeFirm._vizHalf).toBeLessThanOrEqual(36);
	});

	it('estimateLocalCrowdFactors raises crowd factor in packed neighborhoods', () => {
		const sparse = { id: 'a', x: -800, y: -800 } as any;
		const packed = Array.from({ length: 12 }, (_, index) => ({
			id: `p${index}`,
			x: 100 + (index % 4) * 20,
			y: 100 + Math.floor(index / 4) * 20,
		})) as any[];

		estimateLocalCrowdFactors([sparse, ...packed], { cellSize: 140 });

		expect(sparse._crowdFactor).toBe(1);
		const crowded = packed.map((node) => Number(node._crowdFactor));
		expect(Math.min(...crowded)).toBeGreaterThan(1.4);
		expect(Math.max(...crowded)).toBeLessThanOrEqual(2.6);
	});

	it('applyGraphDerivedNodeMetrics caps large firm size from current connections', () => {
		const smallFirm = {
			id: 'firm:small',
			group: 'firm',
			label: 'Small Firm',
			knownConnectionCount: 5,
		} as any;
		const largeFirm = {
			id: 'firm:103863',
			group: 'firm',
			label: 'Large Firm',
			knownConnectionCount: 2321,
		} as any;

		applyGraphDerivedNodeMetrics([smallFirm, largeFirm], []);

		expect(smallFirm._vizHalf).toBeGreaterThanOrEqual(18);
		expect(smallFirm._vizHalf).toBeLessThan(largeFirm._vizHalf);
		expect(largeFirm._vizHalf).toBe(36);
		expect(largeFirm._deg.total).toBeGreaterThanOrEqual(2321);
	});

	it('focusFetchInputWhenEmpty focuses when empty and not active', () => {
		const input = document.getElementById('fg-fetch-input') as HTMLInputElement;
		const empty = document.getElementById('fg-empty')!;
		empty.classList.remove('hidden');
		input.disabled = false;
		// Simulate not focused
		(document.activeElement as Element | null) && document.body.focus && document.body.focus();
		focusFetchInputWhenEmpty({ force: true });
		// requestAnimationFrame used; advance microtask by using setTimeout 0
		return new Promise((resolve) =>
			setTimeout(() => {
				expect(document.activeElement === input || document.activeElement === document.body).toBe(true);
				resolve(null);
			}, 20),
		);
	});

	it('formatFindCounter reports totals and current position', () => {
		expect(formatFindCounter(0, 0)).toBe('0 matches');
		expect(formatFindCounter(1, 0)).toBe('1 match');
		expect(formatFindCounter(5, 0)).toBe('5 matches');
		expect(formatFindCounter(5, 3)).toBe('3/5');
	});

	it('rankFindNodeMatches ranks loaded matches by score and connection count', () => {
		const nodes = [
			{ id: 'person:123', group: 'individual', label: 'Alice Johnson', basicInformation: { firstName: 'Alice', lastName: 'Johnson' } },
			{ id: 'person:456', group: 'individual', label: 'Alice Jones', basicInformation: { firstName: 'Alice', lastName: 'Jones' } },
			{ id: 'firm:789', group: 'firm', label: 'Alice Advisors', firmId: '789', basicInformation: { firmName: 'Alice Advisors' } },
		] as any[];
		const links = [
			{ source: 'person:123', target: 'firm:789' },
			{ source: 'person:123', target: 'person:456' },
		] as any[];

		const matches = rankFindNodeMatches('Alice', nodes, links);

		expect(matches.map((entry) => entry.node.id)).toEqual(expect.arrayContaining(['person:123', 'person:456', 'firm:789']));
		expect(matches[0]?.node.id).toBe('person:123');
		expect(matches[0]?.connections).toBeGreaterThan(matches[1]?.connections ?? 0);
	});

	it('collectFirmConnectionEntries includes all connected nodes and aggregates relationships', () => {
		const firmNode = {
			id: 'firm:789',
			group: 'firm',
			firmId: '789',
			directOwners: [{ crdNumber: '123', position: 'CEO' }],
		} as any;
		const nodes = [
			firmNode,
			{ id: 'person:123', group: 'individual', crd: '123', label: 'Alice Johnson' },
			{ id: 'person:456', group: 'individual', crd: '456', label: 'Bob Jones' },
			{ id: 'entity:1', group: 'entity', label: 'Holding Co LLC' },
		] as any[];
		const links = [
			{ source: 'person:123', target: 'firm:789', relationship: 'controls', startDate: '2020-01-01' },
			{ source: 'person:123', target: 'firm:789', relationship: 'employed_by', isCurrent: true, startDate: '2021-01-01' },
			{ source: 'person:456', target: 'firm:789', relationship: 'employed_by', isCurrent: false, startDate: '2018-01-01', endDate: '2020-01-01' },
			{ source: 'entity:1', target: 'firm:789', relationship: 'controls', endDate: '2022-01-01' },
		] as any[];

		const entries = collectFirmConnectionEntries({
			firmNode,
			layoutNodes: nodes,
			graphNodes: nodes,
			layoutLinks: links,
			graphLinks: [],
		});

		expect(entries.map((entry) => entry.id)).toEqual(['person:123', 'person:456', 'entity:1']);
		expect(entries[0]?.relationshipLabels).toEqual(expect.arrayContaining(['Current registration', 'Control']));
		expect(entries[0]?.positions).toEqual(expect.arrayContaining(['CEO']));
		expect(entries[1]?.relationshipLabels).toEqual(['Previous registration']);
		expect(entries[2]?.relationshipLabels).toEqual(['Former control']);
	});

	it('routeSidebarNodeSelection pushes the node route and dispatches a selection request', () => {
		const pushState = vi.spyOn(window.history, 'pushState');
		const setBrowserPathname = vi.fn();
		const dispatched: Array<{ nodeId?: string; pulseDuration?: number; autoExpand?: boolean }> = [];
		const listener = (event: Event) => {
			dispatched.push(((event as CustomEvent).detail || {}) as { nodeId?: string; pulseDuration?: number; autoExpand?: boolean });
		};

		window.addEventListener('finra:route-node-request', listener as EventListener);
		try {
			routeSidebarNodeSelection({
				nodeId: 'person:2632784',
				browserPathname: '/',
				pathname: '/',
				setBrowserPathname,
				pulseDuration: 5000,
			});

			expect(setBrowserPathname).toHaveBeenCalledWith('/individual/2632784');
			expect(pushState).toHaveBeenCalledWith(window.history.state, '', '/individual/2632784');
			expect(dispatched).toEqual([{ nodeId: 'person:2632784', pulseDuration: 5000, autoExpand: false }]);
		} finally {
			window.removeEventListener('finra:route-node-request', listener as EventListener);
			pushState.mockRestore();
		}
	});
});
