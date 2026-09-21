#!/usr/bin/env bash
# Launch Google Chrome / Chromium on the NVIDIA dGPU (Legion / hybrid AMD+NVIDIA).
#
# Why this exists: on Ubuntu Wayland, Chrome's WebGL often sticks to the AMD iGPU
# (Radeon 780M / Mesa ANGLE) even when an RTX is present. The graph then logs
# "WebGL is on the AMD iGPU" and keeps SVG filters off (SIGILL workaround).
#
# IMPORTANT: env vars only apply to a *new* Chrome process. If Chrome is already
# running on the iGPU, --new-window reuses that process and NVIDIA offload is ignored.
# This script uses a dedicated profile so the NVIDIA instance is always separate.
#
# Usage:
#   bash .local/scripts/chrome-nvidia.sh
#   bash .local/scripts/chrome-nvidia.sh 'http://127.0.0.1:4444/?dgpu=1'
#   CHROME_BIN=/usr/bin/google-chrome-stable bash .local/scripts/chrome-nvidia.sh
set -euo pipefail

if ! command -v nvidia-smi >/dev/null 2>&1; then
	echo "nvidia-smi not found — install the NVIDIA driver first." >&2
	exit 1
fi

echo "NVIDIA GPUs:"
nvidia-smi -L || true

# PRIME render offload (X11/GLX + EGL). Required so ANGLE can see the RTX.
export __NV_PRIME_RENDER_OFFLOAD=1
export __NV_PRIME_RENDER_OFFLOAD_PROVIDER=NVIDIA-G0
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __VK_LAYER_NV_optimus=NVIDIA_only
export DRI_PRIME=1
# Prefer the NVIDIA EGL ICD when several vendors are installed.
if [[ -f /usr/share/glvnd/egl_vendor.d/10_nvidia.json ]]; then
	export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json
fi

CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
	for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
		if command -v "$candidate" >/dev/null 2>&1; then
			CHROME_BIN="$candidate"
			break
		fi
	done
fi

if [[ -z "$CHROME_BIN" ]]; then
	echo "No Chrome/Chromium binary found. Set CHROME_BIN=/path/to/chrome" >&2
	exit 1
fi

URL="${1:-http://127.0.0.1:4444/?dgpu=1&disable_analytics=1}"
PROFILE_DIR="${CHROME_NVIDIA_PROFILE:-$HOME/.config/google-chrome-nvidia-finra}"
mkdir -p "$PROFILE_DIR"

# Wayland sessions: Ozone/X11 is the reliable path for PRIME offload today.
# (Pure Wayland Chrome often keeps WebGL on the AMD iGPU regardless of env.)
EXTRA_FLAGS=(
	--user-data-dir="$PROFILE_DIR"
	--ozone-platform=x11
	--enable-features=VaapiVideoDecoder
	--ignore-gpu-blocklist
	--enable-gpu-rasterization
	--new-window
)

echo "Launching $CHROME_BIN on NVIDIA (dedicated profile + ozone=x11 + PRIME)"
echo "  profile: $PROFILE_DIR"
echo "  URL:     $URL"
echo "  Expect console: NVIDIA / GeForce / RTX — not Radeon 780M."
echo "  Confirm: nvidia-smi shows a chrome/chrome_gpu process."
exec "$CHROME_BIN" "${EXTRA_FLAGS[@]}" "$URL"
