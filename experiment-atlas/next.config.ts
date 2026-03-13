import type { NextConfig } from "next";

const isStaticExport = process.env.ATLAS_STATIC_EXPORT === "1";
const explicitBasePath = process.env.ATLAS_BASE_PATH?.trim();
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim();

const basePath = isStaticExport
  ? explicitBasePath && explicitBasePath !== "/"
    ? explicitBasePath.startsWith("/")
      ? explicitBasePath
      : `/${explicitBasePath}`
    : repositoryName
      ? `/${repositoryName}`
      : undefined
  : undefined;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isStaticExport
    ? {
        output: "export",
        trailingSlash: true,
        images: {
          unoptimized: true,
        },
        basePath,
        assetPrefix: basePath,
      }
    : {}),
};

export default nextConfig;
