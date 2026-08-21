# ADR 0001: TypeScript modular monolith with separate process boundaries

**Status:** Proposed  
**Date:** 2026-08-21

## Context

DevMemoir combines interactive UI, security-sensitive GitHub callbacks, low-latency webhooks, and long-running resumable imports.

## Decision

Use a pnpm TypeScript monorepo with Next.js web, Fastify API, and Node worker applications. Share domain/database/GitHub packages, but deploy API and worker as separately runnable processes. Do not create independently owned microservices.

## Consequences

Webhook and job scaling/failure are isolated while development remains one-language and transactional. The cost is additional process/deployment configuration.

## Rejected

Unified Next.js hides long-work constraints. FastAPI adds a second production language before Python-native analysis is required.

