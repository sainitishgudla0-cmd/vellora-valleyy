import { securityHeaders } from "./config/security-headers.mjs";

const dev = process.env.NODE_ENV !== "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // no "X-Powered-By: Next.js" banner
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [390, 640, 828, 1080, 1280, 1600, 2048],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders({ dev }) },
      {
        source: "/images/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};
export default nextConfig;
