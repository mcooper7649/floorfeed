#!/bin/sh
# Regenerate the server's launchpad ABIs after changing the contracts (run forge build first).
cd "$(dirname "$0")" && node -e '
const fs=require("fs");
const pick=(n)=>JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`)).abi;
fs.writeFileSync("../server/src/abi/launchpad.ts",`// Generated from contracts/out by contracts/sync-abi.sh (do not edit).\nexport const dropAbi = ${JSON.stringify(pick("FloorFeedDrop"))} as const;\nexport const factoryAbi = ${JSON.stringify(pick("FloorFeedFactory"))} as const;\n`);'
