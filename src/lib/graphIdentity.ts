/* eslint-disable @typescript-eslint/no-explicit-any */

function inferNodeGroup(node: any) {
	if (!node || typeof node !== 'object') return '';
	const explicitGroup = String(node.group || node.type || '')
		.trim()
		.toLowerCase();
	if (explicitGroup === 'individual' || explicitGroup === 'person') return 'individual';
	if (explicitGroup === 'firm' || explicitGroup === 'organization' || explicitGroup === 'entity') return 'firm';

	const explicitId = String(node.id ?? '').trim();
	if (/^(?:person|individual)[:_]/i.test(explicitId) || /^person(?:[:_]+)?\d+$/i.test(explicitId) || /^individual(?:[:_]+)?\d+$/i.test(explicitId)) {
		return 'individual';
	}
	if (/^(?:firm|organization)[:_]/i.test(explicitId) || /^firm(?:[:_]+)?\d+$/i.test(explicitId)) {
		return 'firm';
	}

	const firmId = String(node.firmId || node.firm_id || node.basicInformation?.firmId || '').trim();
	if (firmId) return 'firm';

	const personCrd = String(node.crd || node.individualId || node.basicInformation?.individualId || node.basicInformation?.crd || node.basicInformation?.crdNumber || '').trim();
	if (personCrd) return 'individual';

	return '';
}

function getNodeIdentityBaseToken(node: any) {
	if (!node || typeof node !== 'object') return '';
	const explicitId = String(node.id ?? '').trim();
	const inferredGroup = inferNodeGroup(node);
	const idCandidates = [explicitId];
	if (inferredGroup === 'individual') {
		idCandidates.push(String(node.crd || node.basicInformation?.individualId || node.individualId || '').trim());
	} else if (inferredGroup === 'firm') {
		idCandidates.push(String(node.firmId || node.basicInformation?.firmId || node.firm_id || node.crd || node.basicInformation?.crd || '').trim());
	} else {
		idCandidates.push(
			String(
				node.firmId ||
					node.basicInformation?.firmId ||
					node.firm_id ||
					node.crd ||
					node.basicInformation?.individualId ||
					node.individualId ||
					node.basicInformation?.crd ||
					node.basicInformation?.crdNumber ||
					'',
			).trim(),
		);
	}
	for (const candidate of idCandidates) {
		if (!candidate) continue;
		const normalized = String(candidate)
			.replace(/^(?:person|firm|individual|entity|finra|sec)(?:[:_]+)?/i, '')
			.replace(/^[:_]+/, '')
			.trim();
		const lastToken = normalized.split(/[:_]/).filter(Boolean).pop() || normalized;
		if (lastToken) return lastToken;
	}
	return '';
}

export function getNodeIdentityKey(node: any) {
	if (!node || typeof node !== 'object') return '';
	const explicitId = String(node.id ?? '').trim();
	const inferredGroup = inferNodeGroup(node);
	const identityBase = getNodeIdentityBaseToken(node);
	if (inferredGroup === 'individual') {
		const crd = String(node.crd || node.basicInformation?.individualId || node.individualId || '').trim();
		if (crd) return `individual:${crd}`;
		if (identityBase) return `individual:${identityBase}`;
		return explicitId ? `individual:${explicitId}` : '';
	}
	if (inferredGroup === 'firm') {
		const firmId = String(node.firmId || node.basicInformation?.firmId || node.firm_id || node.crd || node.basicInformation?.crd || '').trim();
		if (firmId) return `firm:${firmId}`;
		if (identityBase) return `firm:${identityBase}`;
		return explicitId ? `firm:${explicitId}` : '';
	}
	return explicitId ? `entity:${explicitId}` : '';
}

export function mergeGraphNodePayload(targetNode: any, incomingNode: any) {
	if (!targetNode || !incomingNode) return targetNode;
	const inferredGroup = inferNodeGroup(incomingNode) || inferNodeGroup(targetNode);
	if (!targetNode.group && inferredGroup) targetNode.group = inferredGroup;
	if (incomingNode.group) targetNode.group = incomingNode.group;
	if (inferredGroup === 'firm' && incomingNode.crd && !targetNode.firmId) targetNode.firmId = incomingNode.crd;
	if (incomingNode.firmId && !targetNode.firmId) targetNode.firmId = incomingNode.firmId;
	if (incomingNode.basicInformation?.firmId && !targetNode.basicInformation?.firmId) {
		targetNode.basicInformation = {
			...(targetNode.basicInformation || {}),
			firmId: incomingNode.basicInformation.firmId,
		};
	}
	if (incomingNode._trustedCurrentRelationshipData === true) targetNode._trustedCurrentRelationshipData = true;
	if (incomingNode.bcScope != null) targetNode.bcScope = incomingNode.bcScope;
	if (incomingNode.iaScope != null) targetNode.iaScope = incomingNode.iaScope;
	if (incomingNode.registrationCount) targetNode.registrationCount = { ...(targetNode.registrationCount || {}), ...incomingNode.registrationCount };
	if (Array.isArray(incomingNode.currentEmployments)) targetNode.currentEmployments = incomingNode.currentEmployments;
	if (Array.isArray(incomingNode.currentIAEmployments)) targetNode.currentIAEmployments = incomingNode.currentIAEmployments;
	if (incomingNode.basicInformation) {
		targetNode.basicInformation = {
			...(targetNode.basicInformation || {}),
			...Object.fromEntries(Object.entries(incomingNode.basicInformation || {}).filter(([, value]) => value != null)),
		};
	}
	if (incomingNode.name && !targetNode.name) targetNode.name = incomingNode.name;
	if (incomingNode.firmName && !targetNode.firmName) targetNode.firmName = incomingNode.firmName;
	if (!targetNode.label && incomingNode.label) targetNode.label = incomingNode.label;
	if (incomingNode.crd && !targetNode.crd) targetNode.crd = incomingNode.crd;
	if (incomingNode.individualId && !targetNode.individualId) targetNode.individualId = incomingNode.individualId;
	const incomingKnown = Math.floor(Number(incomingNode.knownConnectionCount) || 0);
	const currentKnown = Math.floor(Number(targetNode.knownConnectionCount) || 0);
	if (incomingKnown > currentKnown) targetNode.knownConnectionCount = incomingKnown;
	const incomingFirmCount = Math.floor(Number(incomingNode.firmCount) || 0);
	const currentFirmCount = Math.floor(Number(targetNode.firmCount) || 0);
	if (incomingFirmCount > currentFirmCount) targetNode.firmCount = incomingFirmCount;
	return targetNode;
}

export function mergeGraphNodesForAppend(existingNodes: any[] = [], incomingNodes: any[] = []) {
	const mergedNodes: any[] = [];
	const identityMap = new Map<string, any>();
	const idRewriteMap = new Map<string, string>();

	const upsertNode = (node: any) => {
		if (!node || typeof node !== 'object') return null;
		const key = getNodeIdentityKey(node);
		if (key && identityMap.has(key)) {
			const targetNode = identityMap.get(key);
			mergeGraphNodePayload(targetNode, node);
			if (node?.id && targetNode?.id && String(node.id) !== String(targetNode.id)) {
				idRewriteMap.set(String(node.id), String(targetNode.id));
			}
			return targetNode;
		}

		const nodeToAdd = { ...node };
		if (key) identityMap.set(key, nodeToAdd);
		mergedNodes.push(nodeToAdd);
		if (node?.id) {
			idRewriteMap.set(String(node.id), String(nodeToAdd.id));
		}
		return nodeToAdd;
	};

	(Array.isArray(existingNodes) ? existingNodes : []).forEach((node) => upsertNode(node));
	(Array.isArray(incomingNodes) ? incomingNodes : []).forEach((incomingNode) => upsertNode(incomingNode));

	return {
		nodes: mergedNodes,
		added: mergedNodes
			.filter((node) => !existingNodes.some((entry) => entry?.id === node?.id))
			.map((node) => node?.id)
			.filter(Boolean),
		idRewriteMap,
	};
}

export function rewriteGraphLinksForNodeIdentity(links: any[] = [], idRewriteMap: Map<string, string> = new Map()) {
	if (!Array.isArray(links)) return [];
	return links.map((link) => {
		if (!link || typeof link !== 'object') return link;
		const rewritten = { ...link };
		const sourceValue = typeof link.source === 'object' && link.source !== null ? (link.source.id ?? null) : link.source;
		const targetValue = typeof link.target === 'object' && link.target !== null ? (link.target.id ?? null) : link.target;
		if (sourceValue != null && idRewriteMap.has(String(sourceValue))) {
			rewritten.source = idRewriteMap.get(String(sourceValue));
		}
		if (targetValue != null && idRewriteMap.has(String(targetValue))) {
			rewritten.target = idRewriteMap.get(String(targetValue));
		}
		return rewritten;
	});
}
