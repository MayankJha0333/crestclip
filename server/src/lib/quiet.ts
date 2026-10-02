// Silence noisy one-time warnings: node:sqlite (only used to import an old SQLite file) and `punycode`.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && (msg.includes('SQLite is an experimental feature') || msg.includes('`punycode` module is deprecated'))) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
