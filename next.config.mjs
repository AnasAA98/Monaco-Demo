/** @type {import('next').NextConfig} */
const nextConfig = {
  // 👇 client-side polyfill to silence “fs” / “path” warnings from Monaco
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { fs: false, path: false };
    }
    return config;
  },
};

export default nextConfig;
