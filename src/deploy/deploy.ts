import assert from 'node:assert';

import type { DeployConfig } from './types.js';
import { Service } from './service.js';

export class Deploy {
    readonly config: DeployConfig;

    constructor(config: DeployConfig) {
        this.config = config;
    }

    get firstService() {
        return this.config.services[0].name;
    }

    service(serviceName?: string) {
        const service = (
            serviceName
                ? this.config.services.find((item) => serviceName === item.name)
                : this.config.services[0]
        );

        assert(service);

        return new Service(this.config, service);
    }
}
