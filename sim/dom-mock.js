// Minimal DOM/browser shim sufficient to let zub_cap_tracker.html's script
// load and define its top-level functions/consts without crashing.
// Nothing here needs to actually render; DOMContentLoaded never fires,
// so the real UI wiring (renderDraftView, tab handlers, etc.) never runs.

function makeFakeEl() {
  const el = {
    style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    dataset: {},
    children: [],
    addEventListener(){},
    removeEventListener(){},
    appendChild(){},
    setAttribute(){},
    getAttribute(){ return null; },
    querySelector(){ return makeFakeEl(); },
    querySelectorAll(){ return []; },
    focus(){},
    click(){},
    getBoundingClientRect(){ return { top:0,left:0,width:0,height:0,bottom:0,right:0 }; },
  };
  Object.defineProperty(el, 'value', { value: '', writable: true });
  Object.defineProperty(el, 'textContent', { value: '', writable: true });
  Object.defineProperty(el, 'innerHTML', { value: '', writable: true });
  return el;
}

const fakeStorage = (() => {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

module.exports = function buildSandbox() {
  const documentMock = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(){ return makeFakeEl(); },
    querySelector(){ return makeFakeEl(); },
    querySelectorAll(){ return []; },
    createElement(){ return makeFakeEl(); },
    visibilityState: 'visible',
    fonts: { ready: Promise.resolve() },
    body: makeFakeEl(),
    documentElement: makeFakeEl(),
  };
  const windowMock = {
    addEventListener(){},
    removeEventListener(){},
    localStorage: fakeStorage,
    innerWidth: 1400,
    innerHeight: 900,
    requestAnimationFrame(cb){ return setTimeout(cb, 0); },
    cancelAnimationFrame(id){ clearTimeout(id); },
  };
  const sandbox = {
    document: documentMock,
    window: windowMock,
    localStorage: fakeStorage,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Object, Array, Set, Map, Date, String, Number, Boolean, RegExp, Error,
    Promise,
    fetch: () => Promise.reject(new Error('network disabled in sim')),
    navigator: { userAgent: 'node-sim' },
    alert(){}, confirm(){ return true; }, prompt(){ return null; },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
};
