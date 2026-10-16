import { realpathSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = realpathSync(process.cwd());
const trusted = new Set([
  realpathSync(fileURLToPath(import.meta.url)),
  realpathSync(fileURLToPath(new URL('./reporter.ts', import.meta.url))),
]);

// Dependency resolution must not borrow a package from outside the evaluated copy.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (isBuiltin(resolved.url)) return resolved;
    if (!resolved.url.startsWith('file:')) throw Error('The check import is outside its copy.');
    const path = realpathSync(fileURLToPath(resolved.url));
    if (!trusted.has(path) && path !== directory && !path.startsWith(`${directory}${sep}`))
      throw Error('The check import is outside its copy.');
    return resolved;
  },
});
