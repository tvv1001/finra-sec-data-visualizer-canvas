'use client';
import React from 'react';
import styles from '@/app/dashboard/dashboard.module.css';

export interface VectorLoaderProps {
	size?: 'sm' | 'md' | 'lg' | 'xl';
	label?: string;
	sublabel?: string;
	className?: string;
	style?: React.CSSProperties;
}

export function VectorLoader({
	size = 'lg',
	label,
	sublabel,
	className = '',
	style,
}: VectorLoaderProps) {
	const sizeClass =
		size === 'xl' ? styles.vectorLoader_xl
		: size === 'lg' ? styles.vectorLoader_lg
		: size === 'md' ? styles.vectorLoader_md
		: styles.vectorLoader_sm;

	return (
		<div
			className={`${styles.vectorLoaderContainer} ${sizeClass} ${className}`}
			style={style}
			role="status"
			aria-live="polite"
		>
			<div className={styles.vectorSpinnerWrapper}>
				<svg className={styles.vectorSpinnerSvg} viewBox="0 0 50 50">
					<circle
						className={styles.vectorSpinnerTrack}
						cx="25"
						cy="25"
						r="20"
						fill="none"
						strokeWidth="3.5"
					/>
					<circle
						className={styles.vectorSpinnerHead}
						cx="25"
						cy="25"
						r="20"
						fill="none"
						strokeWidth="3.5"
						strokeLinecap="round"
					/>
				</svg>
				<div className={styles.vectorSpinnerGlow} />
			</div>
			{(label || sublabel) && (
				<div className={styles.vectorLoaderContent}>
					{label && <span className={styles.vectorLoaderLabel}>{label}</span>}
					{sublabel && <span className={styles.vectorLoaderSublabel}>{sublabel}</span>}
				</div>
			)}
		</div>
	);
}

export default VectorLoader;
