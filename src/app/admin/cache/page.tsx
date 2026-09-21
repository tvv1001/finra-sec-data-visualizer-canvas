'use client';
import React, { useEffect, useState } from 'react';

type Item = {
	type: string;
	id: string;
	nodeId?: string;
	rawCached: boolean;
	rawIsBinary?: boolean;
	rawPreview?: string | null;
	parsedCached: boolean;
	parsedPreview?: string | null;
};

export default function CacheAdminPage() {
	const [items, setItems] = useState<Item[]>([]);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		fetch('/api/cache/status')
			.then((r) => r.json())
			.then((j) => {
				if (j && j.ok && Array.isArray(j.items)) setItems(j.items);
				else setError('Failed to load cache status');
			})
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, []);

	function toggle(key: string) {
		setSelected((s) => ({ ...s, [key]: !s[key] }));
	}

	async function clearSelected() {
		const keys = Object.keys(selected).filter((k) => selected[k]);
		if (!keys.length) return alert('Select some keys first');
		const secret = prompt('Admin secret (x-admin-secret header)');
		if (!secret) return;
		setLoading(true);
		try {
			const res = await fetch('/api/cache/clear', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
				body: JSON.stringify({ keys }),
			});
			const j = await res.json();
			if (!j.ok) throw new Error(j.error || 'clear-failed');
			alert('Cleared: ' + keys.length + ' keys');
			// refresh
			const r2 = await fetch('/api/cache/status');
			const j2 = await r2.json();
			if (j2 && j2.ok) setItems(j2.items);
		} catch (e: any) {
			alert('Error: ' + String(e.message || e));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div style={{ padding: 18 }}>
			<h1>API Cache Admin</h1>
			{loading && <div>Loading…</div>}
			{error && <div style={{ color: 'red' }}>{error}</div>}
			<div style={{ marginTop: 12 }}>
				<button
					onClick={clearSelected}
					disabled={loading}>
					Clear selected
				</button>
			</div>
			<table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
				<thead>
					<tr>
						<th></th>
						<th>Type</th>
						<th>ID</th>
						<th>Raw</th>
						<th>Parsed</th>
						<th>Preview</th>
					</tr>
				</thead>
				<tbody>
					{items.map((it) => {
						const key = `cache:${it.type}::${it.id}`;
						return (
							<tr
								key={key}
								style={{ borderTop: '1px solid #ddd' }}>
								<td style={{ padding: 6 }}>
									<input
										type='checkbox'
										checked={!!selected[key]}
										onChange={() => toggle(key)}
									/>
								</td>
								<td style={{ padding: 6 }}>{it.type}</td>
								<td style={{ padding: 6 }}>{it.id}</td>
								<td style={{ padding: 6 }}>
									{it.rawCached ?
										it.rawIsBinary ?
											'binary'
										:	'text'
									:	'no'}
								</td>
								<td style={{ padding: 6 }}>{it.parsedCached ? 'yes' : 'no'}</td>
								<td style={{ padding: 6, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{it.rawPreview || it.parsedPreview || ''}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
