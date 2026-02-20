import { ssh, testSSH } from '../utils.js';
import type { RemoteConfig } from './types.js';
import { Service } from './service.js';

export class ServiceReleases {
    readonly config: RemoteConfig;
    readonly service: Service;

    constructor(config: RemoteConfig, service: Service) {
        this.config = config;
        this.service = service;
    }

    get releasesDir() {
        return `${this.service.serviceDir}/releases`;
    }

    async list<R = { timestamp: string; current: boolean }>(map?: (v: { timestamp: string; current: boolean }) => R): Promise<R[]> {
        const { stdout } = await ssh(this.config.host, `
    cd "${this.releasesDir}" 2>/dev/null || exit 0
    CURRENT=$(readlink -f ../current || echo "")
    for dir in *; do
      if [ -d "$dir" ]; then
        FULL=$(readlink -f "$dir")
        if [ "$FULL" = "$CURRENT" ]; then
          echo "$dir|current"
        else
          echo "$dir|old"
        fi
      fi
    done
  `);

        return (stdout ?? '').toString()
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [timestamp, status] = line.split('|');
                const current = status === 'current';

                return {
                    timestamp,
                    current,
                };
            })
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
            .map(map ?? ((v) => v as R))
        ;
    }

    async switch(release: string) {
        await ssh(this.config.host, [
            'set -e',
            `ln -sfn "${this.releasesDir}/${release}" "${this.service.serviceDir}/current"`,
        ]);
        await this.service.restart();
    }

    async prune(hours: number) {
        return testSSH({
            host: this.config.host,
            commands: `
set -e
cd "${this.releasesDir}"
NOW=$(date +%s)
CURRENT=$(readlink -f ../current || echo "")

for dir in *; do
  if [ -d "$dir" ]; then
    FULL=$(readlink -f "$dir")
    if [ "$FULL" != "$CURRENT" ]; then
      MTIME=$(stat -c %Y "$dir")
      AGE=$(( (NOW - MTIME) / 3600 ))
      if [ "$AGE" -gt ${hours} ]; then
        rm -rf "$dir"
      fi
    fi
  fi
done`,
        });
    }
}

