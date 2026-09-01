function editSuffixRedirects(trailingSlash) {
  const suffixes = trailingSlash ? ["/", ""] : ["", "/"];
  return suffixes.flatMap((suffix) => [
    {
      source: `/:path*/:page([^/]+\\.html)/edit${suffix}`,
      destination: "/:path*/:page?edit=1",
      permanent: false,
    },
    {
      source: `/:page([^/]+\\.html)/edit${suffix}`,
      destination: "/:page?edit=1",
      permanent: false,
    },
  ]);
}

function isEditSuffixRedirect(route) {
  return Boolean(
    route &&
      typeof route.source === "string" &&
      /\/edit\/?$/.test(route.source) &&
      typeof route.destination === "string" &&
      route.destination.includes("edit=1") &&
      route.permanent === false,
  );
}

function prependEditSuffixRedirects(routes, redirects) {
  const current = Array.isArray(routes) ? routes : [];
  const missing = redirects.filter(
    (redirect) => !current.some((route) => route.source === redirect.source && isEditSuffixRedirect(route)),
  );
  return missing.length ? [...missing, ...current] : current;
}

/**
 * Adds a temporary /path/page.html/edit redirect to /path/page.html?edit=1.
 * The visible destination keeps relative HTML assets anchored to the page directory.
 */
export function withH5Editor(nextConfig = {}) {
  if (typeof nextConfig === "function") {
    return function h5EditorNextConfig(...args) {
      const resolved = nextConfig.apply(this, args);
      return resolved && typeof resolved.then === "function"
        ? resolved.then((config) => withH5Editor(config))
        : withH5Editor(resolved);
    };
  }
  if (nextConfig?.output === "export") return nextConfig;
  const originalRedirects = nextConfig.redirects;
  const redirects = editSuffixRedirects(nextConfig.trailingSlash === true);

  return {
    ...nextConfig,
    async redirects() {
      const current =
        typeof originalRedirects === "function" ? await originalRedirects.call(this) : [];
      return prependEditSuffixRedirects(current, redirects);
    },
  };
}
