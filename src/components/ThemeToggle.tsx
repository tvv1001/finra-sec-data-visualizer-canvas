'use client';

import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'finra_color_scheme';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

function getSavedTheme(): 'light' | 'dark' | null {
	if (typeof window === 'undefined') return null;
	const value = window.localStorage.getItem(STORAGE_KEY);
	return value === 'dark' || value === 'light' ? value : null;
}

function getSystemTheme(): 'light' | 'dark' {
	return 'dark';
}

function applyTheme(theme: 'light' | 'dark') {
	const root = document.documentElement;
	root.dataset.theme = theme;
	root.classList.toggle('theme-dark', theme === 'dark');
}

export default function ThemeToggle() {
	const [theme, setTheme] = useState<'light' | 'dark'>('dark');
	const initializedRef = useRef(false);

	useEffect(() => {
		const savedTheme = getSavedTheme();
		const initialTheme = savedTheme ?? 'dark';
		setTheme(initialTheme);
		applyTheme(initialTheme);
	}, []);

	useEffect(() => {
		if (!initializedRef.current) {
			initializedRef.current = true;
			return;
		}

		window.localStorage.setItem(STORAGE_KEY, theme);
		applyTheme(theme);
	}, [theme]);

	const handleToggle = () => {
		setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
	};

	return (
		<button
			type='button'
			className='fg-sidebar-action-btn fg-sidebar-action-btn--theme fg-sidebar-action-btn--icon-only theme-toggle-btn'
			onClick={handleToggle}
			title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
			aria-pressed={theme === 'dark'}
			aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
			<span
				className='fg-sidebar-action-icon'
				aria-hidden='true'>
				{theme === 'dark' ? '☀️' : '🌙'}
			</span>
		</button>
	);
}
