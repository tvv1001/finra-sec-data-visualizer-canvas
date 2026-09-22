export type GraphSimulationNode = {
	id: string | number;
	x?: number;
	y?: number;
	fx?: number | null;
	fy?: number | null;
	group?: string;
	_deg?: { total?: number };
	_locationBiasX?: number;
	_locationBiasY?: number;
	_locationBiasStrength?: number;
	[key: string]: any;
};

export type GraphSimulationLink = {
	source?: any;
	target?: any;
	relationship?: string;
	[key: string]: any;
};

export type SessionPersistenceMode = 'full' | 'compact' | 'reduced' | 'minimal';
