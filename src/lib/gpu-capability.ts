/**
 * GPU capability tiers for graph visuals.
 *
 * - dedicated: discrete NVIDIA/AMD/Intel Arc alone → full SVG filters / effects
 * - hybrid: discrete + integrated (e.g. RTX 5060 Max-Q + AMD HawkPoint) → keep GPU,
 *   but disable SVG/backdrop filters that SIGILL on the Mesa iGPU compositor path
 * - integrated: iGPU only → safe mode (no crashy filters)
 * - software: llvmpipe / SwiftShader → safe mode
 * - unknown: probe failed → safe mode
 *
 * Overrides: ?safe_gpu=0|1 or localStorage finra_safe_gpu=0|1
 * (safe_gpu means "safe effects / no SIGILL filters", not "disable the GPU")
 */

export type GpuCapabilityTier = 'dedicated' | 'hybrid' | 'integrated' | 'software' | 'unknown';

export const SAFE_GPU_STORAGE_KEY = 'finra_safe_gpu';
export const GPU_TIER_STORAGE_KEY = 'finra_gpu_tier';
export const GPU_RENDERER_STORAGE_KEY = 'finra_gpu_renderer';
/** User asserts a discrete GPU exists (hybrid laptop) even if WebGL only exposes the iGPU. */
export const HYBRID_GPU_STORAGE_KEY = 'finra_hybrid_gpu';

const SOFTWARE_RE = /llvmpipe|swiftshader|software|microsoft basic render|softpipe|opensource software/;
const DEDICATED_NVIDIA_RE = /\b(geforce|rtx|gtx|quadro|tesla|titan)\b/;
const DEDICATED_AMD_RE = /\b(radeon\s*rx|radeon\s*pro|radeon\s*vii|radeon\s*hd\s*[5-9]|rx\s?\d{3,4})\b/;
const DEDICATED_INTEL_ARC_RE = /\b(intel\s*arc|arc\s*(a|b)\d)\b/;
const INTEGRATED_RE =
	/\b(uhd|iris|hd graphics|radeon\s*graphics|radeon\s*\d{2,3}m|radeonsi|phoenix|rembrandt|raphael|hawk.?point|strix|apple\s*m\d|adreno|mali|xclipse|nvidia\s*graphics)\b/;

export function normalizeGpuBlob(renderer = '', vendor = '') {
	return `${renderer} ${vendor}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyGpuCapability(renderer = '', vendor = ''): GpuCapabilityTier {
	const blob = normalizeGpuBlob(renderer, vendor);
	if (!blob) return 'unknown';
	if (SOFTWARE_RE.test(blob)) return 'software';

	// Discrete cards first — hybrid laptops often report the active dGPU here.
	if (DEDICATED_NVIDIA_RE.test(blob) || DEDICATED_AMD_RE.test(blob) || DEDICATED_INTEL_ARC_RE.test(blob)) {
		return 'dedicated';
	}

	// Generic "nvidia" without GeForce/RTX can still be a dGPU (some ANGLE strings).
	if (/\bnvidia\b/.test(blob) && !INTEGRATED_RE.test(blob)) {
		return 'dedicated';
	}

	if (INTEGRATED_RE.test(blob) || /\b(amd|radeon|mesa|intel)\b/.test(blob)) {
		return 'integrated';
	}

	return 'unknown';
}

export function shouldEnableSafeGpuForTier(tier: GpuCapabilityTier): boolean {
	// Full SVG filter effects only on a lone dedicated GPU. Hybrid keeps GPU accel
	// but strips filters — Chrome often composites filters on the Mesa iGPU and SIGILLs.
	return tier !== 'dedicated';
}

export type SafeGpuOverride = 'force-on' | 'force-off' | null;

export function readSafeGpuOverride(search = '', storageGet?: (key: string) => string | null): SafeGpuOverride {
	try {
		const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
		const forced = params.get('safe_gpu') || params.get('safeGpu');
		if (forced === '1' || forced === 'true') return 'force-on';
		if (forced === '0' || forced === 'false') return 'force-off';
	} catch {
		/* ignore */
	}
	try {
		const stored = storageGet?.(SAFE_GPU_STORAGE_KEY) ?? null;
		if (stored === '1' || stored === 'true') return 'force-on';
		if (stored === '0' || stored === 'false') return 'force-off';
	} catch {
		/* ignore */
	}
	return null;
}

export type GpuProbeResult = { renderer: string; vendor: string; powerPreference: string };

function tierRank(tier: GpuCapabilityTier): number {
	if (tier === 'dedicated') return 4;
	if (tier === 'hybrid') return 3;
	if (tier === 'integrated') return 2;
	if (tier === 'software') return 1;
	return 0;
}

/** Prefer discrete NVIDIA/AMD when multiple WebGL contexts are available (hybrid laptops). */
export function pickPreferredGpuProbe(probes: GpuProbeResult[] = []): GpuProbeResult {
	if (!probes.length) return { renderer: '', vendor: '', powerPreference: 'default' };
	const scored = probes.map((probe) => ({
		probe,
		tier: classifyGpuCapability(probe.renderer, probe.vendor),
		preferHighPerf: probe.powerPreference === 'high-performance' ? 1 : 0,
	}));
	scored.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.preferHighPerf - a.preferHighPerf);
	return scored[0].probe;
}

/**
 * Hybrid = we saw both a discrete NVIDIA/AMD dGPU and an integrated GPU across probes
 * (common: RTX Max-Q + AMD HawkPoint / Rembrandt).
 */
export function detectHybridGpu(probes: GpuProbeResult[] = []): boolean {
	let sawDedicated = false;
	let sawIntegrated = false;
	for (const probe of probes) {
		const tier = classifyGpuCapability(probe.renderer, probe.vendor);
		if (tier === 'dedicated') sawDedicated = true;
		if (tier === 'integrated') sawIntegrated = true;
	}
	return sawDedicated && sawIntegrated;
}

function readHybridGpuOptIn(search = '', storageGet?: (key: string) => string | null): boolean {
	try {
		const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
		const flag = params.get('dgpu') || params.get('hybrid_gpu');
		if (flag === '1' || flag === 'true') return true;
		if (flag === '0' || flag === 'false') return false;
	} catch {
		/* ignore */
	}
	try {
		const stored = storageGet?.(HYBRID_GPU_STORAGE_KEY) ?? null;
		if (stored === '1' || stored === 'true') return true;
	} catch {
		/* ignore */
	}
	return false;
}

export function resolveSafeGpuEnabled(options: {
	renderer?: string;
	vendor?: string;
	search?: string;
	storageGet?: (key: string) => string | null;
	probes?: GpuProbeResult[];
	hybrid?: boolean;
}): { enabled: boolean; tier: GpuCapabilityTier; override: SafeGpuOverride; preferredRenderer: string; hybrid: boolean } {
	const override = readSafeGpuOverride(options.search || '', options.storageGet);
	const probes = options.probes?.length ? options.probes : [{ renderer: options.renderer || '', vendor: options.vendor || '', powerPreference: 'default' }];
	const preferred = pickPreferredGpuProbe(probes);
	const hybridOptIn = readHybridGpuOptIn(options.search || '', options.storageGet);
	const hybrid = Boolean(options.hybrid) || detectHybridGpu(probes) || hybridOptIn;
	let tier = classifyGpuCapability(preferred.renderer, preferred.vendor);
	// User-declared hybrid, or probes saw both dGPU + iGPU.
	if (hybrid) tier = 'hybrid';

	if (override === 'force-on') {
		return { enabled: true, tier, override, preferredRenderer: preferred.renderer, hybrid };
	}
	if (override === 'force-off') {
		return { enabled: false, tier, override, preferredRenderer: preferred.renderer, hybrid };
	}
	return {
		enabled: shouldEnableSafeGpuForTier(tier),
		tier,
		override,
		preferredRenderer: preferred.renderer,
		hybrid,
	};
}

function readGlInfo(gl: WebGLRenderingContext): { renderer: string; vendor: string } {
	try {
		const dbg = gl.getExtension('WEBGL_debug_renderer_info');
		if (dbg) {
			return {
				renderer: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''),
				vendor: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''),
			};
		}
		return {
			renderer: String(gl.getParameter(gl.RENDERER) || ''),
			vendor: String(gl.getParameter(gl.VENDOR) || ''),
		};
	} catch {
		return { renderer: '', vendor: '' };
	}
}

/**
 * Probe WebGL with multiple power preferences so hybrid laptops surface the NVIDIA
 * dGPU (high-performance) instead of only the AMD/Intel iGPU (default/low-power).
 */
export function probeWebGlGpuInfo(): { renderer: string; vendor: string; probes: GpuProbeResult[]; hybrid: boolean } {
	if (typeof document === 'undefined') return { renderer: '', vendor: '', probes: [], hybrid: false };
	const preferences = ['high-performance', 'default', 'low-power'] as const;
	const probes: GpuProbeResult[] = [];
	for (const powerPreference of preferences) {
		try {
			const canvas = document.createElement('canvas');
			const gl = canvas.getContext('webgl', {
				powerPreference,
				failIfMajorPerformanceCaveat: false,
				antialias: false,
			}) as WebGLRenderingContext | null;
			if (!gl || typeof gl.getExtension !== 'function') continue;
			const info = readGlInfo(gl);
			if (!info.renderer && !info.vendor) continue;
			probes.push({ ...info, powerPreference });
			try {
				const lose = gl.getExtension('WEBGL_lose_context');
				lose?.loseContext();
			} catch {
				/* ignore */
			}
		} catch {
			/* try next preference */
		}
	}
	const preferred = pickPreferredGpuProbe(probes);
	return {
		renderer: preferred.renderer,
		vendor: preferred.vendor,
		probes,
		hybrid: detectHybridGpu(probes),
	};
}

export function applySafeGpuDomState(enabled: boolean, tier?: GpuCapabilityTier) {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('fg-safe-gpu', enabled);
	document.body?.classList.toggle('fg-safe-gpu', enabled);
	document.documentElement.classList.toggle('fg-hybrid-gpu', tier === 'hybrid');
	if (tier) {
		document.documentElement.dataset.gpuTier = tier;
	}
	document.documentElement.dataset.safeGpu = enabled ? '1' : '0';
}

/**
 * Inline boot script (pre-paint). Keep in sync with classifyGpuCapability / resolveSafeGpuEnabled.
 * Uses persisted tier when present so dedicated-GPU users keep full effects without waiting on WebGL.
 */
export const SAFE_GPU_BOOT_SCRIPT = `
(function () {
  try {
    var root = document.documentElement;
    var params = new URLSearchParams(window.location.search || '');
    var forced = params.get('safe_gpu') || params.get('safeGpu');
    var stored = null;
    var storedTier = null;
    try {
      stored = window.localStorage.getItem('finra_safe_gpu');
      storedTier = window.localStorage.getItem('finra_gpu_tier');
    } catch (e) {}

    function setState(enabled, tier) {
      root.classList.toggle('fg-safe-gpu', !!enabled);
      root.classList.toggle('fg-hybrid-gpu', tier === 'hybrid');
      root.dataset.safeGpu = enabled ? '1' : '0';
      if (tier) root.dataset.gpuTier = tier;
    }

    if (forced === '1' || forced === 'true') { setState(true, storedTier || 'unknown'); return; }
    if (forced === '0' || forced === 'false') { setState(false, storedTier || 'dedicated'); return; }
    if (stored === '1' || stored === 'true') { setState(true, storedTier || 'unknown'); return; }
    if (stored === '0' || stored === 'false') { setState(false, storedTier || 'dedicated'); return; }

    // Persisted positive dedicated detection → full capability before first paint.
    if (storedTier === 'dedicated') { setState(false, 'dedicated'); return; }
    // Hybrid / iGPU / software → filter-safe before first paint (avoids Mesa SVG-filter SIGILL).
    if (storedTier === 'hybrid' || storedTier === 'integrated' || storedTier === 'software' || storedTier === 'unknown') {
      setState(true, storedTier);
      return;
    }

    // First visit on Linux: start safe until WebGL multi-probe confirms a lone dedicated GPU.
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var isLinux = /linux/i.test(platform) || /Linux/.test(ua);
    if (isLinux) { setState(true, 'unknown'); return; }

    // Non-Linux first visit: optimistic full capability until probe.
    setState(false, 'unknown');
  } catch (error) {
    try { document.documentElement.classList.add('fg-safe-gpu'); } catch (e) {}
  }
})();
`;
