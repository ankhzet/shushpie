import blessed, { Widgets } from 'blessed';
import chalk from 'chalk';

import { sleep, testSSH } from '../utils.js';
import { selectFromList, makeProgram, showMessage, statusBox, pause } from '../ui.js';
import type { DeployConfig } from './types.js';
import { Deploy } from './deploy.js';
import { clearInterval } from 'node:timers';

//
// UI
//

export const ui = async (config: DeployConfig) => await makeProgram(`Deploy Manager`, async ({ screen }) => {
    const deploy = new Deploy(config);
    let service = deploy.service();

    const { promise, resolve } = Promise.withResolvers();

    const container = blessed.box({
        parent: screen,
        left: 0,
        top: 0,
        padding: { left: 1, right: 1 },
        width: '100%',
        height: '100%',
        border: 'line',
    });
    const servicePane = blessed.box({
        parent: container,
        right: 0,
        top: 0,
        padding: 1,
        width: '100%-30',
        height: '100%-2',
    });
    const releasesPane = blessed.box({
        parent: container,
        right: -1,
        top: 1,
        padding: { left: 1, top: 0, right: 0, bottom: 0 },
        width: '50%',
        height: '100%-3',
    });

    blessed.line({
        parent: container,
        top: 0,
        left: 25,
        width: 1,
        height: '100%-2',
        orientation: 'vertical',
        type: 'line',
    });

    statusBox(screen, {
        dull: false,
        width: 'shrink',
        left: '100%-82',
        content: 's: switch service  |  r: switch release  |  p: prune old releases  |  q: quit',
    });

    servicePane.append(blessed.box({
        left: 'center',
        top: -2,
        width: 'shrink',
        height: 'shrink',
        content: `[ Service (${chalk.blue(service.label)}) ]`,
        align: 'center',
    }));

    const status = statusBox(screen, {
        dull: false,
        width: 'shrink',
        left: 2,
    });

    const setLines = (e: Widgets.BlessedElement, lines: string | (string | false | undefined | null)[]) => e.setContent(
        Array.isArray(lines) ? lines.filter((l) => (l ?? false) !== false).join('\n') : lines,
    );

    let interval: NodeJS.Timeout | undefined;
    let connected = false;
    const errors = [
        chalk.yellow(`Could not connect to ${config.host}`),
        chalk.gray(`Could not connect to ${config.host}`),
    ];
    const isConnected = async (cb?: () => Promise<unknown>) => {
        if (connected) {
            if (cb) {
                await cb();
            }

            return true;
        }

        if (interval) {
            clearInterval(interval);
            interval = undefined;
        }

        for (let i = 0; i < 8; i++) {
            await sleep(300);
            status.content(errors[i % 2]);
        }

        status.content(errors[0]);
    };
    const updateGlobals = () => setLines(container, [
        '',
        `Project:`,
        `\t${chalk.blue(config.project)}`,
        '',
        `Services:`,
        ...config.services.map(({ name, label }) => `  ${service.name === name ? '*' : ' '} ${chalk.blue(label)}`),
        '',
        `${chalk.yellow('c')}: check connection`,
        connected && `${chalk.yellow('s')}: switch service`,
        `${chalk.yellow('q')}: quit`,
    ]);

    const updateStatus = () => isConnected(async () => {
        const ts = new Date();
        const { name, installed, loaded, active, location, reason } = await service.status();

        if (reason.includes('Could not resolve hostname')) {
            connected = false;
            void isConnected();
            return;
        }

        setLines(servicePane, [
            `Name: ${chalk.blue(name)}`,
            `Installed: ${installed ? chalk.green('yes') : chalk.red('no')}`,
            `Loaded: ${loaded === 'yes' ? chalk.green(loaded) : chalk.yellow(loaded)}`,
            location && `\t${chalk.gray(location)}`,
            `Active: ${active === 'active' ? chalk.green(active) : chalk.yellow(active)} ${ts.toLocaleString()}`,
            reason && ` \ ${chalk.yellow(reason)}`,
            `\nService controls:      Release controls:`,
            `\t${chalk.yellow('i')}: install         \t${chalk.yellow('e')}: switch release`,
            `\t${chalk.gray('u')}: uninstall       \t${chalk.yellow('p')}: prune old releases`,
            `\t${chalk.yellow('r')}: restart`,
        ]);

        status.content(`${chalk.green(config.host)} > ${chalk.blue(service.label)} (${service.name})`);
    });
    const statusfull = async <T>(title: string, cb: () => T | Promise<T>) => status.preserve(async () => {
        status.content(title);
        await sleep(200);

        return cb();
    });
    const checkConnection = async () => {
        const result = await statusfull(chalk.gray(`Connecting to "${config.host}"...`), () => testSSH({
            host: config.host,
            commands: 'echo "Connectable"',
            test: ({ stdout }) => stdout.includes('Connectable'),
        }));

        if ((connected = result.success)) {
            await updateStatus();
            interval = setInterval(updateStatus, 5000);
        } else {
            await isConnected();
        }

        return connected;
    };
    const switchService = async (name: string) => {
        service = deploy.service(name);

        await updateStatus();

        if (!connected) {
            return;
        }

        const result = await statusfull(chalk.gray(`Checking "${service.label}" releases...`), () => testSSH({
            host: config.host,
            commands: `ls ${service.releases.releasesDir}`,
            test: ({ stderr }) => !stderr,
        }));

        updateGlobals();

        setLines(releasesPane, result.success ? [
            result.stdout,
        ] : [
            `${chalk.gray('No releases')}`,
        ]);
    };

    updateGlobals();

    if (await checkConnection()) {
        await switchService(deploy.firstService);
    }

    screen.key('c', checkConnection);

    screen.key('s', () => isConnected(async () => {
        const selected = await selectFromList({
            screen,
            title: `Services`,
            cb: async () => config.services.map(({ name, label }) => ({
                value: name,
                label,
            })),
        });

        if (selected) {
            await switchService(selected);
        }
    }));

    screen.key('i', () => isConnected(async () => {
        const result = await statusfull(chalk.gray(`Installing "${service.label}"...`), () => service.install());

        if (result.success) {
            await updateStatus();
        } else {
            await pause(
                screen,
                chalk.red(`Failed to install "${service.label}" to "${config.host} -> ${service.serviceDir}":\n${result.stderr}`),
            );
        }
    }));

    screen.key('r', () => isConnected(async () => {
        const result = await statusfull(chalk.gray(`Restarting "${service.label}"...`), () => service.restart());

        if (result.success) {
            await updateStatus();
        } else {
            await pause(
                screen,
                chalk.red(`Failed to restart "${service.label}" to "${config.host} -> ${service.serviceDir}":\n${result.stderr}`),
            );
        }
    }));

    screen.key('e', () => isConnected(async () => {
        const selected = await selectFromList({
            screen,
            title: `Releases (${service.label})`,
            cb: () => service.releases.list(({ timestamp, current }) => ({
                value: timestamp,
                label: current ? `* ${timestamp} (current)` : timestamp,
            })),
        });

        if (selected) {
            await service.releases.switch(selected);
        }
    }));

    screen.key('p', async () => {
        if (!(await isConnected())) {
            return;
        }

        const hours = config.keepHours ?? 48;

        try {
            const { stdout } = await service.releases.prune(hours);

            await showMessage({
                screen,
                content: stdout,
                duration: 5000,
            });
        } catch (e: any) {
            if (`${e.message || e}`.includes('No such file or directory')) {
                await pause(screen, chalk.yellow('Service not installed'));
            }
        }
    });

    screen.on('destroy', resolve);

    screen.render();

    return promise;
});
