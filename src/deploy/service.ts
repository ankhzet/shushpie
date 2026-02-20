import path from 'node:path';
import { ssh, testSSH } from '../utils.js';
import type { ServiceConfig, RemoteConfig } from './types.js';
import { ServiceReleases } from './releases.js';

function buildUnit(baseDir: string, service: ServiceConfig): string {
    const args = service.exec.args?.join(' ') ?? '';
    const envLines = Object.entries(service.env ?? {})
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join('\n');

    return `
[Unit]
Description=${service.label}
After=network.target ${service.requires ? `${service.requires}.service` : ''}
${service.requires ? `Requires=${service.requires}.service` : ''}

StartLimitIntervalSec=30
StartLimitBurst=5

[Service]
Type=simple
User=debian
WorkingDirectory=${path.posix.join(baseDir, service.name, 'current')}
ExecStart=${service.exec.command} ${args}
Restart=always
RestartSec=2
${envLines}

[Install]
WantedBy=multi-user.target
`.trim();
}

const RE_STATUS = /Loaded: (?<loaded>\w+) \((?<location>[^)]+)\).*Active: (?<active>\w+)\s*(?:\((?<reason>[^)]+)\))?/is;

export class Service {
    readonly service: ServiceConfig;
    readonly remote: RemoteConfig;

    constructor(remote: RemoteConfig, service: ServiceConfig) {
        this.remote = remote;
        this.service = service;
    }

    get label() {
        return this.service.label;
    }

    get name() {
        return this.service.name;
    }

    get serviceName() {
        return `${this.remote.project}-${this.service.name}`;
    }

    get releases() {
        return new ServiceReleases(this.remote, this);
    }

    get serviceDir() {
        return `${this.remote.baseDir}/${this.name}`;
    }

    async status() {
        const name = this.serviceName;
        const installed = await testSSH({
            host: this.remote.host,
            commands: `ls ${this.serviceDir}`,
        });

        const result = await testSSH({
            host: this.remote.host,
            commands: `systemctl status ${name}`,
        });

        if (result.success) {
            const match = result.stdout.match(RE_STATUS);

            if (match) {
                return { ...match.groups, name, installed: installed.success } as {
                    installed: boolean;
                    name: string;
                    loaded: string;
                    active: string;
                    location: string;
                    reason: string;
                };
            }
        }

        return {
            name,
            installed: installed.success,
            loaded: 'no',
            active: 'inactive',
            location: this.serviceDir,
            reason: result.stderr,
        };
    }

    async restart() {
        return testSSH({
            host: this.remote.host,
            commands: [
                'set -e',
                `sudo systemctl restart ${this.serviceName}`,
            ],
        });
    }

    async install() {
        const unit = buildUnit(this.remote.baseDir, {
            ...this.service,
            requires: this.service.requires?.map((dep) => dep.replace('.', `${this.remote.project}-`))
        });
        const guard = `${this.serviceName} Installed successfully`;

        return testSSH({
            host: this.remote.host,
            commands: [
                `mkdir -p ${this.serviceDir}`,
                `mkdir -p ${this.releases.releasesDir}`,
                `sudo tee /etc/systemd/system/${this.serviceName}.service > /dev/null`,
                'sudo systemctl daemon-reload',
                `echo "${guard}"`,
            ],
            test: ({ stdout, stderr }) => stdout.includes(guard) && !stderr,
            input: Buffer.from(unit),
        });
    }
}
