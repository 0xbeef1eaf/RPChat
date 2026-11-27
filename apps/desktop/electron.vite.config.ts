import { resolve } from 'node:path';
import type { PluginOption } from 'vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Workspace packages must be bundled into the main/preload output (they are
 * ESM sources that Electron's Node cannot resolve through pnpm's layout).
 * Packages that ship wasm/native binaries stay external.
 */
const WORKSPACE_PACKAGES = ['@rp/shared', '@rp/sdk', '@rp/pack', '@rp/llm', '@rp/sandbox', '@rp/core'];
const ALWAYS_EXTERNAL = ['electron', 'quickjs-emscripten', 'esbuild'];

/**
 * `@vitejs/plugin-react` only adds Fast Refresh (dev) and optional Babel
 * transforms; Vite's esbuild pipeline already compiles TSX with the automatic
 * JSX runtime. Load it when it is compatible with the installed Vite, and
 * fall back to plain esbuild otherwise (the installed 6.x requires Vite 8;
 * pin `@vitejs/plugin-react@^5.2` for Vite 7 to get Fast Refresh back).
 */
async function reactPlugin(): Promise<PluginOption[]> {
  try {
    const mod = await import('@vitejs/plugin-react');
    return [mod.default()];
  } catch (err) {
    console.warn(`[electron.vite.config] @vitejs/plugin-react unavailable, using esbuild JSX only: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Guardrail: esbuild snapshots `process.env.ESBUILD_BINARY_PATH` once when first required. Any
 * static import of `esbuild` anywhere in the main bundle gets hoisted to the top of
 * `out/main/index.js`, before `configureEsbuildBinary()` can point it at `app.asar.unpacked`,
 * causing `esbuild.build`/`transform` to fail with `spawn ENOTDIR` in packaged builds.
 */
function forbidEagerEsbuildPlugin(): PluginOption {
  return {
    name: 'forbid-eager-esbuild',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.imports.some((id) => id === 'esbuild' || id.startsWith('esbuild/'))) {
          this.error(
            `${fileName} statically imports "esbuild"; load it lazily (e.g. await import("esbuild") or createRequire) so configureEsbuildBinary() sets ESBUILD_BINARY_PATH first.`,
          );
        }
      }
    },
  };
}

export default defineConfig(async () => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), forbidEagerEsbuildPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: [...ALWAYS_EXTERNAL, /^quickjs-emscripten(\/|$)/, /^esbuild(\/|$)/, /^@jitl\/quickjs-/],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
      },
    },
  },
  renderer: {
    plugins: await reactPlugin(),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          media: resolve(__dirname, 'src/renderer/media.html'),
          prompt: resolve(__dirname, 'src/renderer/prompt.html'),
        },
      },
    },
  },
}));
