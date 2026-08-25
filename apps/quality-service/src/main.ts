#!/usr/bin/env node
import { QualityStore, startServer } from "./index.js";

const dbPath = process.env.PRAXIS_QUALITY_DB ?? ":memory:";
const store = new QualityStore(dbPath);
startServer({ store });
