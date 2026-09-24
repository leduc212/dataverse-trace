// Loaded with a dynamic import() to prove code-split chunks resolve relative to the web resource URL.
export const lazyLoaded = (): string => `lazy chunk loaded from ${import.meta.url}`;
