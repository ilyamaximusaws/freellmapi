// ---- Platform & Model Types ----
/** Platforms whose keys serve web search (POST /v1/search and the agents'
 *  web_search tools), never chat. Search engine rows arrive through the
 *  catalog's `searchEngines` registry. The server keeps its own runtime copy in
 *  server/src/lib/search-platforms.ts (shared is type-only on the server). */
export const SEARCH_PLATFORMS = ['tavily', 'exa', 'firecrawl', 'linkup', 'parallel', 'serpsearch', 'keenable', 'brave', 'outcrawl'];
export function isSearchPlatform(platform) {
    return SEARCH_PLATFORMS.includes(platform);
}
//# sourceMappingURL=types.js.map