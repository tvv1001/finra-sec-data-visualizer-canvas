/* Worker start/stop helper extracted from the previous canvas renderer
 * Provides startForceWorker(nodes, links, width, height, onTick) and stopForceWorker()
 */

export let _forceWorker: Worker | null = null;

export function startForceWorker(nodes: any[], links: any[], width = 800, height = 600, onTick?: (nodes: any[]) => void) {
	if (typeof window === 'undefined' || typeof Worker !== 'function') return null;
	if (_forceWorker) {
		try {
			_forceWorker.postMessage({ type: 'stop' });
		} catch {}
		try {
			_forceWorker.terminate();
		} catch {}
		_forceWorker = null;
	}
	const workerUrl = '/workers/d3-force-worker.js';
	try {
		_forceWorker = new Worker(workerUrl, { type: 'module' });
	} catch (err) {
		try {
			_forceWorker = new Worker('/workers/d3-force-worker.bundle.js', { type: 'module' });
		} catch (fallbackErr) {
			const workerCode = `
            let nodes = [];
            let links = [];
            let running = false;
            let width = ${width}, height = ${height};
            function stepSim() {
                if (!running) return;
                const k = 0.02;
                for (let i = 0; i < nodes.length; i++) {
                    let ni = nodes[i];
                    let fx = 0, fy = 0;
                    for (let j = 0; j < nodes.length; j++) {
                        if (i === j) continue;
                        const nj = nodes[j];
                        let dx = ni.x - nj.x;
                        let dy = ni.y - nj.y;
                        let dist2 = dx*dx + dy*dy + 0.01;
                        let force = 1000 / dist2;
                        fx += (dx/dist2) * force;
                        fy += (dy/dist2) * force;
                    }
                    const locStrength = Number.isFinite(ni.locStrength) ? ni.locStrength : 0;
                    if (locStrength > 0) {
                        fx += (Number.isFinite(ni.locX) ? (ni.locX - ni.x) : 0) * locStrength * 2.2;
                        fy += (Number.isFinite(ni.locY) ? (ni.locY - ni.y) : 0) * locStrength * 1.9;
                    } else {
                        fx += (width / 2 - ni.x) * 0.006;
                        fy += (height / 2 - ni.y) * 0.006;
                    }
                    ni.vx = (ni.vx || 0) + fx * 0.001;
                    ni.vy = (ni.vy || 0) + fy * 0.001;
                }
                for (let l of links) {
                    const s = nodes.find(n => String(n.id) === String(l.source));
                    const t = nodes.find(n => String(n.id) === String(l.target));
                    if (!s || !t) continue;
                    const dx = t.x - s.x;
                    const dy = t.y - s.y;
                    const dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
                    const desired = 70;
                    const diff = dist - desired;
                    const f = 0.001 * diff;
                    const nx = (dx/dist) * f;
                    const ny = (dy/dist) * f;
                    s.vx = (s.vx || 0) + nx;
                    s.vy = (s.vy || 0) + ny;
                    t.vx = (t.vx || 0) - nx;
                    t.vy = (t.vy || 0) - ny;
                }
                for (let n of nodes) {
                    n.x = (n.x || width/2) + (n.vx || 0);
                    n.y = (n.y || height/2) + (n.vy || 0);
                    n.vx *= 0.9;
                    n.vy *= 0.9;
                }
                postMessage({ type: 'tick', nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y })) });
                setTimeout(stepSim, 16);
            }
            onmessage = function(e) {
                const m = e.data || {};
                if (m.type === 'init') {
                    nodes = m.nodes.map(n => ({ id: n.id, x: n.x || 0, y: n.y || 0, locX: n.locX, locY: n.locY, locStrength: n.locStrength || 0 }));
                    links = m.links.map(l => ({ source: l.source, target: l.target }));
                    width = m.width || width;
                    height = m.height || height;
                    postMessage({ type: 'ready' });
                } else if (m.type === 'start') { running = true; stepSim(); }
                else if (m.type === 'stop') { running = false; }
                else if (m.type === 'updateNodes') {
                    for (const p of m.positions || []) {
                        const n = nodes.find(x => String(x.id) === String(p.id)); if (n) { n.x = p.x; n.y = p.y; }
                    }
                }
            };
        `;
			const blob = new Blob([workerCode], { type: 'application/javascript' });
			_forceWorker = new Worker(URL.createObjectURL(blob));
		}
	}
	_forceWorker.onmessage = (ev) => {
		const msg = ev.data || {};
		if (msg.type === 'tick' && Array.isArray(msg.nodes)) {
			if (typeof onTick === 'function') {
				try {
					onTick(msg.nodes);
				} catch (e) {}
			}
		}
	};
	_forceWorker.postMessage({
		type: 'init',
		nodes: nodes.map((n) => ({
			id: n.id,
			x: n.x,
			y: n.y,
			locX: n._locationBiasX,
			locY: n._locationBiasY,
			locStrength: n._locationBiasStrength,
		})),
		links: links.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target })),
		width,
		height,
	});
	_forceWorker.postMessage({ type: 'start' });
	return _forceWorker;
}

export function stopForceWorker() {
	if (_forceWorker) {
		try {
			_forceWorker.postMessage({ type: 'stop' });
		} catch (e) {}
		try {
			_forceWorker.terminate();
		} catch (e) {}
		_forceWorker = null;
	}
}
