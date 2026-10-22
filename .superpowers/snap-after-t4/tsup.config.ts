import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    paypal: 'src/paypal/index.ts',
    legacy: 'src/legacy/index.ts',
    subscription: 'src/subscription-core/index.ts',
  },
  format: ['esm', 'cjs'],
  // One shared chunk for core classes across entries (CJS `instanceof` identity).
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['@idevconn/payment'],
});
