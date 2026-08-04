/**
 * The six applications whose dependency trees this app x-rays.
 *
 * These manifests are hand-authored, but everything they point at is real: real
 * package names, real semver ranges, and the entire transitive closure,
 * publish dates, maintainer lists, licenses and advisories are fetched live
 * from registry.npmjs.org and api.osv.dev. Nothing about the graph itself is
 * invented.
 *
 * The set is deliberately shaped to make the graph interesting:
 *   - Different dependency topologies (a wide framework tree vs. a narrow CLI).
 *   - Deliberate overlap, so the shared-choke-point query has something to find.
 *   - One deliberately neglected project, pinned to exact versions that carry
 *     published advisories. Without it the blast-radius view demos empty.
 */

import type { AppNode } from "../../src/lib/model";

export type Manifest = AppNode & {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export const MANIFESTS: Manifest[] = [
  {
    slug: "storefront-web",
    name: "storefront-web",
    kind: "Web app",
    description: "Customer-facing storefront. Next.js, server components, Stripe checkout.",
    dependencies: {
      next: "^15.1.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      "@tanstack/react-query": "^5.62.0",
      stripe: "^17.5.0",
      zod: "^3.24.1",
      clsx: "^2.1.1",
      "date-fns": "^4.1.0",
      swr: "^2.2.5",
      "lucide-react": "^0.469.0",
    },
    devDependencies: {
      typescript: "^5.7.2",
      tailwindcss: "^3.4.17",
      vitest: "^2.1.8",
      "@testing-library/react": "^16.1.0",
      eslint: "^9.17.0",
    },
  },
  {
    slug: "orders-api",
    name: "orders-api",
    kind: "Service",
    description: "Order lifecycle REST API. Express, MongoDB, Redis-backed job queue.",
    dependencies: {
      express: "^4.21.2",
      mongoose: "^8.9.2",
      jsonwebtoken: "^9.0.2",
      bcryptjs: "^2.4.3",
      pino: "^9.5.0",
      dotenv: "^16.4.7",
      joi: "^17.13.3",
      axios: "^1.7.9",
      bullmq: "^5.34.4",
      ioredis: "^5.4.2",
    },
    devDependencies: {
      nodemon: "^3.1.9",
      jest: "^29.7.0",
      supertest: "^7.0.0",
    },
  },
  {
    slug: "mobile-companion",
    name: "mobile-companion",
    kind: "Mobile app",
    description: "React Native companion app for order tracking and push notifications.",
    dependencies: {
      "react-native": "^0.76.5",
      react: "^18.3.1",
      "@react-navigation/native": "^7.0.14",
      "react-native-reanimated": "^3.16.5",
      "@reduxjs/toolkit": "^2.5.0",
      "react-redux": "^9.2.0",
      axios: "^1.7.9",
      moment: "^2.30.1",
    },
    devDependencies: {
      jest: "^29.7.0",
      typescript: "^5.7.2",
    },
  },
  {
    slug: "deploy-cli",
    name: "deploy-cli",
    kind: "CLI tool",
    description: "Internal deployment CLI. Narrow, deliberate dependency tree.",
    dependencies: {
      commander: "^12.1.0",
      chalk: "^5.4.1",
      ora: "^8.1.1",
      execa: "^9.5.2",
      cosmiconfig: "^9.0.0",
      yaml: "^2.6.1",
      undici: "^7.2.0",
      prompts: "^2.4.2",
    },
    devDependencies: {
      esbuild: "^0.24.2",
      tsx: "^4.19.2",
    },
  },
  {
    slug: "analytics-worker",
    name: "analytics-worker",
    kind: "Data pipeline",
    description: "Kafka consumer that rolls events into Postgres for reporting.",
    dependencies: {
      kafkajs: "^2.2.4",
      pg: "^8.13.1",
      knex: "^3.1.0",
      "csv-parse": "^5.6.0",
      lodash: "^4.17.21",
      luxon: "^3.5.0",
      "fast-json-stringify": "^6.0.1",
      "node-fetch": "^3.3.2",
    },
    devDependencies: {
      tsup: "^8.3.5",
      vitest: "^2.1.8",
    },
  },
  {
    slug: "legacy-admin",
    name: "legacy-admin",
    kind: "Legacy app",
    description:
      "Internal admin panel nobody has upgraded since 2019. Exact pins, no renovate bot, and a long list of published advisories.",
    // Exact pins, not ranges. The point of this app is to sit *on* the
    // vulnerable versions rather than float past them, so the blast-radius and
    // fix-point queries have real advisories with real paths to trace.
    dependencies: {
      request: "2.88.2",
      lodash: "4.17.15",
      minimist: "1.2.0",
      express: "4.16.0",
      handlebars: "4.1.0",
      moment: "2.24.0",
      axios: "0.21.0",
      tar: "4.4.10",
      ejs: "2.7.4",
      "node-fetch": "2.6.0",
      shelljs: "0.8.3",
      marked: "0.7.0",
      ws: "5.2.2",
      "serialize-javascript": "2.1.2",
      y18n: "4.0.0",
      "http-proxy-middleware": "0.19.1",
    },
    devDependencies: {
      grunt: "1.0.4",
      "jquery": "3.4.0",
    },
  },
];

export function manifestNodes(): AppNode[] {
  return MANIFESTS.map(({ slug, name, description, kind }) => ({
    slug,
    name,
    description,
    kind,
  }));
}
