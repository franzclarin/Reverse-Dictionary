/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // @xenova/transformers loads native ONNX Runtime — must stay external so
    // webpack doesn't bundle it and Vercel ships its binaries with the function.
    serverComponentsExternalPackages: ["@xenova/transformers"],
    // RD-11: ship the 86MB model INSIDE the function so /api/lookup never
    // downloads it at request time. scripts/fetch-model.mjs populates models/
    // during the build (it's gitignored, so tracing is the only thing that
    // gets it into the bundle). lib/embedder.ts runs with
    // `allowRemoteModels = false`, so if this glob ever stops matching, the
    // route fails loudly rather than silently reverting to the ~39s download.
    outputFileTracingIncludes: {
      "/api/lookup": ["./models/**"],
    },
    // Counterweight to the 86MB the model adds. File tracing pulls in
    // onnxruntime-node's binaries for EVERY platform (~74MB traced, of which
    // linux is ~30MB); Vercel functions are linux, so the macOS and Windows
    // copies are pure bundle weight. Measured on a local build: 195MB traced
    // before this, which is uncomfortably close to the legacy 250MB function
    // limit. Excludes only affect the traced output — local dev still reads
    // node_modules directly, so `npm run dev` on macOS is unaffected.
    outputFileTracingExcludes: {
      "/api/lookup": [
        "node_modules/onnxruntime-node/bin/napi-v3/darwin/**",
        "node_modules/onnxruntime-node/bin/napi-v3/win32/**",
      ],
    },
  },
}

module.exports = nextConfig
