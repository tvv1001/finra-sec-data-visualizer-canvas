'use client';
import dynamic from 'next/dynamic';

const FinraGraph = dynamic(() => import('@/components/FinraGraph'), {
	ssr: false,
	loading: () => (
		<div className='fg-loading-shell'>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<div className='fg-header-brand'>
						<h1 className='fg-title'>FINRA</h1>
					</div>
				</div>
			</header>
			<main className='fg-main fg-loading-main'>
				<div className='fg-empty-card'>
					<p className='fg-empty-eyebrow'>Loading graph…</p>
				</div>
			</main>
		</div>
	),
});

export default function HomePage() {
	return <FinraGraph />;
}
