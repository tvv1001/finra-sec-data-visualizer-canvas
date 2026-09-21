let wasmReady = false;
let mod = null;

async function tryImportGlue() {
	try {
		// This glue file lives in /public and is served as-is at runtime — it must not be
		// statically resolved/bundled by Turbopack/webpack as a project module, hence the
		// ignore comment forcing a genuine runtime dynamic import of the absolute URL.
		const graph_layout = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '/wasm/graph-layout/graph_layout.js');
		await graph_layout.default();
		wasmReady = true;
		mod = graph_layout;
	} catch (err) {
		postMessage({ type: 'error', message: 'Failed to load WASM glue: ' + String(err) });
	}
}

const readyPromise = tryImportGlue();

onmessage = async (ev) => {
	const msg = ev.data || {};
	if (msg && msg.type === 'compute') {
		await readyPromise;
		if (!mod || typeof mod.GraphSimulation !== 'function') {
			postMessage({ type: 'error', message: 'WASM GraphSimulation not available' });
			return;
		}
		try {
            let nodes = [];
            let links = [];
            if (typeof msg.nodesJson === 'string') {
                nodes = JSON.parse(msg.nodesJson);
            } else {
                nodes = msg.nodesJson || [];
            }
            if (typeof msg.linksJson === 'string') {
                links = JSON.parse(msg.linksJson);
            } else {
                links = msg.linksJson || [];
            }

            const width = msg.width || 800;
            const height = msg.height || 600;

            const simulation = new mod.GraphSimulation(width, height);
            
            const idToIndex = new Map();
            nodes.forEach((n, i) => {
                idToIndex.set(String(n.id), i);
                simulation.add_node(
                    Number.isFinite(n.x) ? n.x : width / 2, 
                    Number.isFinite(n.y) ? n.y : height / 2, 
                    Number.isFinite(n.r) ? n.r : 6,
                    Number.isFinite(n.locStrength) ? n.locStrength : 0, 
                    Number.isFinite(n.locX) ? n.locX : width / 2, 
                    Number.isFinite(n.locY) ? n.locY : height / 2
                );
            });
            
            links.forEach(link => {
                const s = idToIndex.get(String(link.source));
                const t = idToIndex.get(String(link.target));
                if (s !== undefined && t !== undefined) {
                    simulation.add_link(s, t);
                }
            });

            // Run iterations inside WASM (8 iterations)
            simulation.tick(8);

            const posArray = simulation.get_positions();
            
            const positions = [];
            for (let i = 0; i < nodes.length; i++) {
                positions.push({
                    id: nodes[i].id,
                    x: posArray[i * 2],
                    y: posArray[i * 2 + 1]
                });
            }

			postMessage({ type: 'result', positions });
		} catch (e) {
			postMessage({ type: 'error', message: String(e) });
		}
	}
};
