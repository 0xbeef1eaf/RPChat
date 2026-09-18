/**
 * Vite's `?worker` import: the bundler turns that module into a chunk of its own and hands
 * back a constructor that starts it. `vite/client`'s own declarations are deliberately not
 * in scope (tsconfig.web.json takes no ambient `types`), so the one shape we use is here.
 */
declare module '*?worker' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
