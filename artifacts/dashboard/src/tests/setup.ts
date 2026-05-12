import "@testing-library/jest-dom";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function () {};
}
