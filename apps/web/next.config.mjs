/** @type {import('next').NextConfig} */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

const nextConfig = {
  // `output: 'standalone'` is enabled in containerized deployments (Phase 7);
  // it is disabled here because Windows symlink tracing requires Developer Mode.
  async rewrites() {
    return [
      { source: '/v1/:path*', destination: `${API_URL}/v1/:path*` },
      { source: '/healthz', destination: `${API_URL}/healthz` },
      { source: '/readyz', destination: `${API_URL}/readyz` },
    ];
  },
};

export default nextConfig;