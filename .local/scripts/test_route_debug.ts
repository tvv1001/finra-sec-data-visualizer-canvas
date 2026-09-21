import { GET } from '../src/app/api/finra/individual/[crd]/route';
import { NextRequest } from 'next/server';
import fs from 'node:fs';

try {
	const content = fs.readFileSync('.env.local', 'utf-8');
	for (const line of content.split('\n')) {
		const match = line.match(/^\s*([\w.\-_]+)\s*=\s*(.*)\s*$/);
		if (match) {
			const key = match[1];
			let value = match[2].trim();
			if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
			if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
			process.env[key] = value;
		}
	}
} catch (e) {}

async function main() {
	const crd = '3104103';
	console.log(`Calling GET /api/finra/individual/${crd} route handler`);
	
	// Create mock NextRequest
	const req = new NextRequest(`http://localhost:4444/api/finra/individual/${crd}?merged=1`);
	
	// Invoke GET
	const response = await GET(req, { params: Promise.resolve({ crd }) });
	console.log('Status:', response.status);
	const data = await response.json();
	console.log('JSON Data keys:', Object.keys(data));
	if (response.status === 500) {
		console.log('Error Details:', data);
	}
}

main().catch(console.error);
