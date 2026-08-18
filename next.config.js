/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @xenova/transformers loads native ONNX Runtime — must stay external so
  // webpack doesn't bundle it and Vercel ships its binaries with the function.
  experimental: {
    serverComponentsExternalPackages: ["@xenova/transformers"],
  },
}

module.exports = nextConfig
