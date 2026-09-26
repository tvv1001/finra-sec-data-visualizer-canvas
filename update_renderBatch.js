const fs = require('fs');
const file = 'src/lib/finra-graph.ts';
let code = fs.readFileSync(file, 'utf8');

const targetStr = `			const batchHiddenIds = revealBatches[Math.min(batchIndex, revealBatches.length - 1)] || [];
			const batchNodes =
				batchHiddenIds.length ?
					placeNodesNearConnections(
						clickedNode,
						globalState.graphData.nodes.filter((n) => batchHiddenIds.includes(n.id)),
						candidateLinks,
						dist,
					)
				:	[];
			const existingNodeIds = new Set((Array.isArray(globalState.layoutNodes) ? globalState.layoutNodes : []).map((node) => node.id));
			const mergeResult = mergeIncomingNodesIntoExistingNodes(globalState.layoutNodes, batchNodes);
			const newRenderNodes = mergeResult.nodes.filter((node) => !existingNodeIds.has(node.id));
			globalState.layoutNodes = mergeResult.nodes;
			activeRenderedIds = new Set(globalState.layoutNodes.map((node) => node.id));
			const batchNodeIds = new Set(newRenderNodes.map((n) => n.id));
			
			// Precompute existing directed edges to avoid O(E * D) complexity
			const renderedDirectedEdges = new Set();
			if (globalState.layoutLinks) {
				for (const ll of globalState.layoutLinks) {
					const es = ll.source?.id ?? ll.source;
					const et = ll.target?.id ?? ll.target;
					if (es && et) renderedDirectedEdges.add(\`\${es}::\${et}\`);
				}
			}

			const batchLinks = rewriteLinksForNodeIdMap(
				candidateLinks
					.filter((link) => {`;

const newStr = `			const batchHiddenIds = revealBatches[Math.min(batchIndex, revealBatches.length - 1)] || [];
			const batchHiddenIdsSet = new Set(batchHiddenIds);
			const batchNodes =
				batchHiddenIds.length ?
					placeNodesNearConnections(
						clickedNode,
						globalState.graphData.nodes.filter((n) => batchHiddenIdsSet.has(n.id)),
						candidateLinks,
						dist,
					)
				:	[];
			const existingNodeIds = new Set((Array.isArray(globalState.layoutNodes) ? globalState.layoutNodes : []).map((node) => node.id));
			const mergeResult = mergeIncomingNodesIntoExistingNodes(globalState.layoutNodes, batchNodes);
			const newRenderNodes = mergeResult.nodes.filter((node) => !existingNodeIds.has(node.id));
			globalState.layoutNodes = mergeResult.nodes;
			activeRenderedIds = new Set(globalState.layoutNodes.map((node) => node.id));
			const batchNodeIds = new Set(newRenderNodes.map((n) => n.id));
			
			// Efficiently gather only the candidate links touching this batch instead of filtering all links
			const batchLinksToCheck = new Set();
			if (batchNodeIds.size > 0) {
				for (const nid of batchNodeIds) {
					for (const adjEntry of fullAdj.get(nid) || []) {
						if (activeRenderedIds.has(adjEntry.nodeId) || batchNodeIds.has(adjEntry.nodeId)) {
							if (typeof linkFilter === 'function' && !linkFilter(adjEntry.link)) continue;
							batchLinksToCheck.add(adjEntry.link);
						}
					}
				}
			}
			const candidateLinksSubset = Array.from(batchLinksToCheck);
			
			// Precompute existing directed edges to avoid O(E * D) complexity
			const renderedDirectedEdges = new Set();
			if (globalState.layoutLinks) {
				for (const ll of globalState.layoutLinks) {
					const es = ll.source?.id ?? ll.source;
					const et = ll.target?.id ?? ll.target;
					if (es && et) renderedDirectedEdges.add(\`\${es}::\${et}\`);
				}
			}

			const batchLinks = rewriteLinksForNodeIdMap(
				candidateLinksSubset
					.filter((link) => {`;

code = code.replace(targetStr, newStr);
fs.writeFileSync(file, code);
