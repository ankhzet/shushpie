#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import type { DeployConfig } from './types.js';
import { ui } from './switch.js';

const [, , pathname] = process.argv;

const config: DeployConfig = JSON.parse(
    fs.readFileSync(path.resolve(pathname || 'deploy.json'), 'utf-8'),
);

await ui(config);
