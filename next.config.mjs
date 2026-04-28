/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow LAN-IP dev access (e.g. testing from another device on the network)
  // without the Next 15 cross-origin warning.
  allowedDevOrigins: ['192.168.1.65', 'localhost', '127.0.0.1'],
  // 👇 client-side polyfill to silence “fs” / “path” warnings from Monaco
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { fs: false, path: false };
    }
    return config;
  },
};

export default nextConfig;
