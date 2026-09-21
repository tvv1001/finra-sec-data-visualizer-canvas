// Simple wrapper to call the graph layout worker from the main thread.
export function createGraphLayoutWorker() {
	const worker = new Worker(new URL('../workers/graphLayout.worker.js', import.meta.url), { type: 'module' });

	function compute(nodes, links, width = 800, height = 600) {
		return new Promise((resolve, reject) => {
			const onmsg = (ev) => {
				const m = ev.data || {};
				if (m.type === 'result') {
					worker.removeEventListener('message', onmsg);
					resolve(m.positions);
				} else if (m.type === 'error') {
					worker.removeEventListener('message', onmsg);
					reject(new Error(m.message || 'worker error'));
				}
			};
			worker.addEventListener('message', onmsg);
			worker.postMessage({ type: 'compute', nodesJson: nodes, linksJson: links, width, height });
		});
	}

	return { worker, compute };
}

export default createGraphLayoutWorker;
