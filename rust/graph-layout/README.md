# graph-layout (Rust → WASM)

This crate provides a small force-layout implementation intended to be compiled to WebAssembly and used from the browser. It exports `compute_layout(nodes_json, links_json, width, height)` via wasm-bindgen.

Build (local)

1. Install wasm-pack (https://rustwasm.github.io/wasm-pack/installer/)
2. From repo root:

```bash
pnpm run build:wasm:release
pnpm run optimize:wasm  # optional if wasm-opt (binaryen) is installed
```

The build outputs to `public/wasm/graph-layout/` so the worker can load the generated JS and wasm files.

CI

Use the provided GitHub Actions workflow `.github/workflows/wasm-build.yml` which installs `wasm-pack` and `binaryen` and produces an artifact.

Optimization tips

- Enable `lto = true` in `Cargo.toml` (already set) and `opt-level = "s"` for small size.
- Use `wasm-opt -O3 --vacuum` to reduce size and improve performance.
- For heavy numeric workloads, consider enabling SIMD and threading (requires COOP/COEP and wasm-bindgen-rayon).

Parallel/threads proof-of-concept

This crate supports an optional `parallel` feature which enables Rayon-based parallel loops in the layout algorithm and integrates with `wasm-bindgen-rayon` for browser threads.

To build with the parallel feature (locally):

```bash
cd rust/graph-layout
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' wasm-pack build --release --target web --out-dir ../../public/wasm/graph-layout -- --features parallel
```

Important runtime requirements:

- You must initialize the wasm-bindgen-rayon thread pool from JS before using Rayon-enabled functions. Example initialization (in your app bootstrap):

```js
import init, { initThreadPool } from '/wasm/graph-layout/graph_layout.js';

await init();
// initThreadPool expects the number of worker threads to create
await initThreadPool(navigator.hardwareConcurrency || 4);
```

- The hosting page must enable SharedArrayBuffer by sending COOP/COEP headers on responses. On Next/Vercel configure headers:
  - Cross-Origin-Opener-Policy: same-origin
  - Cross-Origin-Embedder-Policy: require-corp

  Without these headers the browser will refuse to enable SharedArrayBuffer and thread support.

CI note

The provided GitHub Actions workflow installs `binaryen` and builds the normal non-parallel wasm by default. If you want to build the parallel variant in CI you must adjust the workflow step to pass `--features parallel` to `wasm-pack` (and ensure the runner supports SharedArrayBuffer tests if you run any runtime tests).
