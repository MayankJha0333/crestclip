// Silence the one-time "SQLite is an experimental feature" warning from node:sqlite.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && (msg.includes('SQLite is an experimental feature') || msg.includes('`punycode` module is deprecated'))) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
