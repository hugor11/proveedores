// Proxy to ESM implementation to avoid duplicates.
// Netlify/esbuild soporta import() dinámico desde CJS.

exports.handler = async (event, context) => {
  const mod = await import('./api.mjs');
  return mod.handler(event, context);
};
