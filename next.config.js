/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @xenova/transformers uses native ONNX Runtime binaries — must not be bundled by webpack
  experimental: {
    serverComponentsExternalPackages: ["@xenova/transformers"],
  },
}

module.exports = nextConfig
