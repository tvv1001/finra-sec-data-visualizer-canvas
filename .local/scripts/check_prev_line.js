(async () => {
	const puppeteer = require('puppeteer');
	const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true });
	const p = await b.newPage();
	try {
		await p.goto('http://localhost:4444/node/person-3107080', { waitUntil: 'networkidle2', timeout: 120000 });
		const el = await p.$('.fg-timeline--previous');
		if (!el) {
			console.log('no el');
			await b.close();
			return;
		}
		const style = await p.evaluate((el) => {
			const s = getComputedStyle(el, '::before');
			return { content: s.content, left: s.left, width: s.width, background: s.backgroundColor, zIndex: s.zIndex };
		}, el);
		console.log('::before style:', style);
		const count = await p.$$eval('.fg-timeline--previous .fg-tl-entry', (els) => els.length);
		console.log('entries', count);
		const activeCount = await p.$$eval('.fg-timeline--previous .fg-tl-entry.active-pos', (els) => els.length);
		console.log('active entries inside previous section', activeCount);
	} catch (err) {
		console.error(err);
	} finally {
		await b.close();
	}
})();
