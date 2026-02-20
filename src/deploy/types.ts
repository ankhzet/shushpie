export interface SyncMap {
    from: string;
    to: string;
}

export interface ServiceConfig {
    name: string;
    label: string;
    exec: {
        command: string;
        args?: string[];
    };
    sync: SyncMap[];
    requires?: string[];
    env?: Record<string, string>;
}

export interface RemoteConfig {
    project: string;
    host: string;
    baseDir: string;
}

export interface DeployConfig extends RemoteConfig {
    keepHours: number;
    services: ServiceConfig[];
}

export type Constructor<T extends abstract new (...args: any) => any> = {
    new(...args: ConstructorParameters<T>): T;
};
