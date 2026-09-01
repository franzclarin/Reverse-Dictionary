/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
        // The model library loads native code, so it must stay outside the bundler.
    serverComponentsExternalPackages: ["@xenova/transformers"],
        // Ship the 86MB model with the app, so it is never downloaded while someone
        // is waiting. The build downloads it into a folder that is not committed, so
        // this line is the only thing that gets it packaged. The app refuses to
        // download at run time, so if this stops matching it fails loudly rather
        // than quietly reverting to a 40-second wait.
    outputFileTracingIncludes: {
      "/api/lookup": ["./models/**"],
    },
        // Counterweight to the model's size. Packaging pulls in that library's
        // binaries for every operating system; the server only ever runs one of
        // them, so the rest are dead weight — and the total was uncomfortably close
        // to the size limit. This only affects what gets packaged; local development
        // is unaffected.
    outputFileTracingExcludes: {
      "/api/lookup": [
        "node_modules/onnxruntime-node/bin/napi-v3/darwin/**",
        "node_modules/onnxruntime-node/bin/napi-v3/win32/**",
      ],
    },
  },
}

module.exports = nextConfig
