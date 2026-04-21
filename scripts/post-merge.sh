#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
cd lib/api-client-react && npx tsc --build && cd -
