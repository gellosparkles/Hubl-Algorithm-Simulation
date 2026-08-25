import "@testing-library/jest-dom";

// Guarded so this file is harmless if it is ever loaded outside jsdom.
// Engine/service tests run in the `node` project and skip setup entirely.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
