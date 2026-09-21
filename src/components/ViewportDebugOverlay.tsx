'use client';

import { useEffect, useMemo, useState } from 'react';

type OverlayState = {
	enabled: boolean;
	focused: string;
	fontSize: string;
	scale: string;
	innerWidth: number;
	innerHeight: number;
	visualWidth: string;
	visualHeight: string;
	offsetTop: string;
	offsetLeft: string;
};

function formatNumber(value: number | undefined, fractionDigits = 2) {
	return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(fractionDigits) : '—';
}

function getFocusedDescriptor(activeElement: Element | null) {
	if (!activeElement || !(activeElement instanceof HTMLElement)) {
		return 'none';
	}

	const parts = [activeElement.tagName.toLowerCase()];
	if (activeElement.id) {
		parts.push(`#${activeElement.id}`);
	}
	if (activeElement.classList.length > 0) {
		parts.push(`.${Array.from(activeElement.classList).join('.')}`);
	}
	return parts.join('');
}

export default function ViewportDebugOverlay() {
	const [state, setState] = useState<OverlayState>({
		enabled: false,
		focused: 'none',
		fontSize: '—',
		scale: '—',
		innerWidth: 0,
		innerHeight: 0,
		visualWidth: '—',
		visualHeight: '—',
		offsetTop: '—',
		offsetLeft: '—',
	});

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const queryEnabled = params.get('debugViewport') === '1';
		const storedEnabled = window.localStorage.getItem('fg_debug_viewport') === '1';
		const enabled = queryEnabled || storedEnabled;

		if (queryEnabled) {
			window.localStorage.setItem('fg_debug_viewport', '1');
		}

		if (!enabled) {
			return;
		}

		const update = () => {
			const activeElement = document.activeElement;
			const focused = getFocusedDescriptor(activeElement);
			const activeStyle = activeElement instanceof HTMLElement ? window.getComputedStyle(activeElement) : null;
			const viewport = window.visualViewport;

			setState({
				enabled: true,
				focused,
				fontSize: activeStyle?.fontSize ?? '—',
				scale: formatNumber(viewport?.scale, 3),
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				visualWidth: formatNumber(viewport?.width),
				visualHeight: formatNumber(viewport?.height),
				offsetTop: formatNumber(viewport?.offsetTop),
				offsetLeft: formatNumber(viewport?.offsetLeft),
			});
		};

		update();
		window.addEventListener('resize', update);
		window.addEventListener('orientationchange', update);
		document.addEventListener('focusin', update);
		document.addEventListener('focusout', update);
		window.visualViewport?.addEventListener('resize', update);
		window.visualViewport?.addEventListener('scroll', update);

		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('orientationchange', update);
			document.removeEventListener('focusin', update);
			document.removeEventListener('focusout', update);
			window.visualViewport?.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('scroll', update);
		};
	}, []);

	const rows = useMemo(
		() => [
			['focus', state.focused],
			['font', state.fontSize],
			['scale', state.scale],
			['inner', `${state.innerWidth} × ${state.innerHeight}`],
			['visual', `${state.visualWidth} × ${state.visualHeight}`],
			['offset', `${state.offsetLeft}, ${state.offsetTop}`],
		],
		[state],
	);

	if (!state.enabled) {
		return null;
	}

	return (
		<div
			className='fg-viewport-debug'
			aria-live='polite'>
			<div className='fg-viewport-debug__title'>Viewport debug</div>
			{rows.map(([label, value]) => (
				<div
					key={label}
					className='fg-viewport-debug__row'>
					<span className='fg-viewport-debug__label'>{label}</span>
					<span className='fg-viewport-debug__value'>{value}</span>
				</div>
			))}
			<div className='fg-viewport-debug__hint'>
				Add <code>?debugViewport=1</code> to enable.
			</div>
		</div>
	);
}
