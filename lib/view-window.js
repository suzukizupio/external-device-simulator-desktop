"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ViewWindow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function page(items, requestedPage = 0, requestedSize = 50) {
    const source = Array.isArray(items) ? items : [];
    const size = positiveInteger(requestedSize, 50);
    const pageCount = Math.max(1, Math.ceil(source.length / size));
    const pageIndex = Math.min(Math.max(Number(requestedPage) || 0, 0), pageCount - 1);
    const startIndex = pageIndex * size;
    const endIndex = Math.min(startIndex + size, source.length);
    return {
      items: source.slice(startIndex, endIndex),
      total: source.length,
      pageIndex,
      pageCount,
      start: source.length ? startIndex + 1 : 0,
      end: endIndex,
      hasPrevious: pageIndex > 0,
      hasNext: pageIndex + 1 < pageCount,
    };
  }

  function tail(items, requestedLimit = 2000) {
    const source = Array.isArray(items) ? items : [];
    const limit = positiveInteger(requestedLimit, 2000);
    const startIndex = Math.max(0, source.length - limit);
    return {
      items: source.slice(startIndex),
      total: source.length,
      omitted: startIndex,
    };
  }

  return Object.freeze({ page, tail });
});
