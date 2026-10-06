#!/usr/bin/env bun
import { main } from "../src/cli/index";
process.exitCode = await main(process.argv.slice(2));
