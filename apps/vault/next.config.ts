import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Disclosure-mode bridge: the only page agent apps may frame (contracts/apps.md V6, V7). It has no approve
        // or confirm controls, and answers only the approved origin.
        source: "/bridge",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "Permissions-Policy", value: "publickey-credentials-get=*, publickey-credentials-create=*" },
        ],
      },
      {
        source: "/((?!bridge$).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The vault must never be framed: passkey ceremonies and consent happen here.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};
export default config;
