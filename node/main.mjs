#!/usr/bin/env node
import fs from 'node:fs';import {runPool} from './pool.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node node/main.mjs PRIVATE_CONFIG.json [--once]');
const config=JSON.parse(fs.readFileSync(file,'utf8'));if(!process.argv.includes('--once'))config.claim_wait_seconds??=20;
await runPool(config,{once:process.argv.includes('--once')});
