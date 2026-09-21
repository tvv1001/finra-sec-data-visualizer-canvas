let nodes = [];
let links = [];
let running = false;
let width = 800;
let height = 600;
let wasmApi = null;
let simulation = null;
let tickTimer = null;

async function ensureWasm() {
	if (wasmApi) return wasmApi;
	try {
		const mod = await import('/wasm/graph-layout/graph_layout.js');
		if (typeof mod.default === 'function') {
			await mod.default();
		}
		wasmApi = mod;
		return mod;
	} catch (err) {
		console.warn('[wasm-worker] rust wasm worker unavailable', err);
		throw err;
	}
}

function postPositions() {
	if (!nodes.length) return;
	postMessage({ type: 'tick', nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) });
}

async function stepSimulation() {
	if (!running) return;
	try {
        if (!simulation) {
            running = false;
            return;
        }
        
        simulation.tick(1);
        
        const positions = simulation.get_positions();
        for (let i = 0; i < nodes.length; i++) {
            nodes[i].x = positions[i * 2];
            nodes[i].y = positions[i * 2 + 1];
        }
        
		postPositions();
	} catch (err) {
		postMessage({ type: 'error', error: String(err) });
		running = false;
		return;
	}
	if (running) {
		tickTimer = setTimeout(stepSimulation, 16);
	}
}

onmessage = async function (event) {
	const message = event.data || {};
	if (message.type === 'init') {
		nodes = (message.nodes || []).map((n) => ({
			id: n.id,
			x: Number.isFinite(n.x) ? n.x : width / 2,
			y: Number.isFinite(n.y) ? n.y : height / 2,
            r: Number.isFinite(n.r) ? n.r : 6,
			locX: Number.isFinite(n.locX) ? n.locX : null,
			locY: Number.isFinite(n.locY) ? n.locY : null,
			locStrength: Number.isFinite(n.locStrength) ? n.locStrength : 0,
		}));
		links = (message.links || []).map((link) => ({ source: link.source, target: link.target }));
		width = Number.isFinite(message.width) ? message.width : width;
		height = Number.isFinite(message.height) ? message.height : height;
        
        try {
            const mod = await ensureWasm();
            simulation = new mod.GraphSimulation(width, height);
            
            // Map string IDs to indices
            const idToIndex = new Map();
            nodes.forEach((n, i) => {
                idToIndex.set(n.id, i);
                simulation.add_node(
                    n.x, 
                    n.y, 
                    n.r,
                    n.locStrength, 
                    n.locX !== null ? n.locX : width / 2, 
                    n.locY !== null ? n.locY : height / 2
                );
            });
            
            links.forEach(link => {
                const s = idToIndex.get(link.source);
                const t = idToIndex.get(link.target);
                if (s !== undefined && t !== undefined) {
                    simulation.add_link(s, t);
                }
            });
            
		    postMessage({ type: 'ready' });
        } catch (err) {
            postMessage({ type: 'error', error: String(err) });
        }
	} else if (message.type === 'start') {
		running = true;
		if (tickTimer) clearTimeout(tickTimer);
		stepSimulation();
	} else if (message.type === 'stop') {
		running = false;
		if (tickTimer) clearTimeout(tickTimer);
	} else if (message.type === 'updateNodes') {
		for (const p of message.positions || []) {
			const index = nodes.findIndex((entry) => String(entry.id) === String(p.id));
			if (index !== -1) {
                const node = nodes[index];
				node.x = Number.isFinite(p.x) ? p.x : node.x;
				node.y = Number.isFinite(p.y) ? p.y : node.y;
                if (simulation) {
                    simulation.update_node(index, node.x, node.y);
                }
			}
		}
	}
};
