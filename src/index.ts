#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blessed from 'blessed';
import { usb } from 'usb';
import chalk from 'chalk';
import { execa } from 'execa';
import drivelist, { type Drive } from 'drivelist';

let isExiting = false;
let screen: ReturnType<typeof blessed.screen>;
let program: ReturnType<typeof blessed.program>;

async function cleanup() {
    if (isExiting) return;
    isExiting = true;

    usb.removeAllListeners();
    screen?.destroy();
    program?.clear();
    console.log(chalk.gray('\n👋 Interrupted. Exiting gracefully.'));
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const withResolvers = <T = void>() => {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (e: unknown) => void;
    const promise = new Promise<T>((rs, rj) => {
        resolve = rs;
        reject = rj;
    });

    return {
        promise,
        resolve: resolve!,
        reject: reject!,
    };
};

async function getRemovableDrives(): Promise<Array<{ drive: Drive; path: string; label: string }>> {
    const drives = await drivelist.list();

    return (
        drives
            .filter((drive) => (
                drive.isRemovable && !drive.mountpoints.some(p => p.path.includes('/Library/'))
            ))
            .map((drive) => {
                const paths = drive.mountpoints.map(p => p.path);

                return {
                    drive,
                    path: paths.find(p => /boot/i.test(p)) || paths[0],
                    label: `${drive.device} (${drive.description || 'Unknown'}) - ${paths || 'No mountpoint'}`,
                };
            })
    );
}

type DialogOptions<T> = {
    container: blessed.Widgets.BoxElement;
    submit: (value: T | PromiseLike<T> | null) => void;
    close: () => void;
};

const dialog = async <T>(
    screen: blessed.Widgets.Screen,
    cb: (options: DialogOptions<T>) => Promise<void>,
) => {
    const { promise, resolve } = withResolvers<T | null>();

    const container = blessed.box({
        top: 'center',
        left: 'center',
        width: '80%',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        keys: true,
        mouse: true,
    });

    const submit = (value: T | PromiseLike<T> | null) => {
        container.destroy();
        screen.render();
        resolve(value);
    };
    const close = () => submit(null);

    container.key(['q', 'escape'], close);

    await cb({ container, submit, close });

    screen.append(container);
    screen.render();

    return promise;
};

const mssgBox = (container: blessed.Widgets.BoxElement, message: string) => {
    container.append(blessed.box({
        top: 2,
        left: 'center',
        content: message,
        style: { fg: 'yellow' },
    }));
    container.append(blessed.box({
        bottom: 0,
        left: 0,
        width: '100%',
        height: 1,
        content: ' Esc Cancel ',
        style: { fg: 'gray' },
    }));
};

async function selectDrive(screen: blessed.Widgets.Screen): Promise<string | null> {
    return dialog(screen, async ({ container, submit }) => {
        const drives = await getRemovableDrives();
        const total = drives.length;

        container.append(blessed.box({
            top: 0,
            left: 0,
            width: '100%',
            height: 1,
            content: ' Select boot drive ',
            tags: true,
        }));

        if (total) {
            const list = blessed.list({
                top: 2,
                left: 0,
                height: total + 2,
                items: drives.map(({ label }) => label),
                style: {
                    selected: { bg: 'blue', fg: 'white' },
                    item: { fg: 'white' },
                },
            });
            list.select(0);
            container.focus();
            container.append(list);

            container.append(blessed.box({
                bottom: 0,
                left: 0,
                width: '100%',
                height: 1,
                content: ' ↑↓ Select | Enter Confirm | Esc Cancel ',
                style: { fg: 'gray' },
            }));

            let selectedIndex = 0;

            container.key(['enter', 'o', 'return', 'space'], () => {
                const selected = drives[selectedIndex];

                if (selected) {
                    submit(selected.path);
                }
            });

            container.key(['up', 'k', 'p'], () => {
                selectedIndex = (selectedIndex + total - 1) % total;
                list.select(selectedIndex);
                screen.render();
            });

            container.key(['down', 'j', 'n'], () => {
                selectedIndex = (selectedIndex + total + 1) % total;
                list.select(selectedIndex);
                screen.render();
            });
        } else {
            mssgBox(container, ' No removable drives found. ');
        }
    });
}

async function pause(screen: ReturnType<typeof blessed.screen>, message: string): Promise<void> {
    const container = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        keys: true,
        mouse: true,
    });

    const msg = blessed.box({
        left: 0,
        width: '100%',
        height: 'shrink',
        content: message,
        tags: true,
    });
    container.append(msg);

    const btn = blessed.box({
        top: 4,
        left: 'center',
        width: 30,
        height: 1,
        content: ' [ Press Enter to continue ] ',
        style: { bg: 'blue', fg: 'white', bold: true },
    });
    container.append(btn);

    screen.append(container);
    screen.render();
    container.focus();

    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });

    container.key(['enter', 'return', 'space'], () => {
        container.destroy();
        screen.render();
        resolvePromise();
    });

    container.key(['escape', 'q', 'C-c'], () => {
        container.destroy();
        screen.render();
        resolvePromise();
    });

    return promise;
}

async function waitForUsb(screen: ReturnType<typeof blessed.screen>): Promise<string> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'yellow' } },
        content: ' Waiting for Raspberry Pi USB connection...\n\n (Connect Pi via USB cable) ',
        tags: true,
    });
    screen.append(box);
    screen.render();

    const deviceName = await new Promise<string>((resolve, reject) => usb.once('attach', (device) => {
        box.destroy();

        device.open();
        device.getStringDescriptor(device.deviceDescriptor.iProduct, async (err, value) => {
            device.close();

            if (err) {
                reject(err);
            } else {
                resolve(value?.trim() || 'Unknown device');
            }
        });
    }));
    await showMessage(screen, ` USB device connected!\n ${deviceName} `);

    return deviceName;
}

async function waitForPing(screen: ReturnType<typeof blessed.screen>, host = 'raspberrypi.local'): Promise<string> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: ` Pinging ${host}... `,
        tags: true,
    });
    screen.append(box);
    screen.render();

    const hostnames = [host, '169.254.0.2'];

    for (let i = 0; i < hostnames.length; i++) {
        const currentHost = hostnames[i];
        if (i > 0) {
            box.setContent(chalk.red(`Ping failed. Trying ${currentHost}...`));
            screen.render();
        }

        for (let attempt = 1; attempt <= 15; attempt++) {
            box.setContent(` Pinging ${currentHost}... (${attempt}/15) `);
            screen.render();

            try {
                await execa('ping', ['-c', '1', '-W', '1', currentHost]);
                box.destroy();
                const success = blessed.box({
                    top: 'center',
                    left: 'center',
                    width: 'shrink',
                    height: 'shrink',
                    border: { type: 'line' },
                    style: { border: { fg: 'green' } },
                    content: ` ${currentHost} is reachable! `,
                    tags: true,
                });
                screen.append(success);
                screen.render();
                await new Promise(r => setTimeout(r, 1000));
                success.destroy();
                return currentHost;
            } catch {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    box.destroy();
    const failed = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'red' } },
        content: ' Pi did not respond to ping. ',
        tags: true,
    });
    screen.append(failed);
    screen.render();
    await new Promise(r => setTimeout(r, 2000));
    failed.destroy();

    throw new Error('Pi did not respond to ping.');
}

async function trySsh(screen: ReturnType<typeof blessed.screen>, host: string): Promise<void> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: ` SSH to pi@${host}... `,
        tags: true,
    });
    screen.append(box);
    screen.render();

    try {
        await execa('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=5',
            `pi@${host}`,
            'echo SSH OK',
        ], { stdio: 'inherit' });

        box.destroy();
        const success = blessed.box({
            top: 'center',
            left: 'center',
            width: 'shrink',
            height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'green' }, bold: true },
            content: ' Success! Pi is reachable over USB! ',
            tags: true,
        });
        screen.append(success);
        screen.render();
    } catch {
        box.destroy();
        const failed = blessed.box({
            top: 'center',
            left: 'center',
            width: 'shrink',
            height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'red' } },
            content: ' SSH failed. Check cable or wait longer. ',
            tags: true,
        });
        screen.append(failed);
        screen.render();
    }
}

async function setupBootDrive(bootPath: string) {
    const sshPath = path.join(bootPath, 'ssh');
    const configPath = path.join(bootPath, 'config.txt');
    const cmdlinePath = path.join(bootPath, 'cmdline.txt');

    fs.writeFileSync(sshPath, '');

    let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    if (!config.includes('dtoverlay=dwc2')) {
        config += '\n\ndtoverlay=dwc2\n';
        fs.writeFileSync(configPath, config);
    }

    let cmdline = fs.readFileSync(cmdlinePath, 'utf8');
    if (!cmdline.includes('modules-load=dwc2,g_ether')) {
        cmdline = cmdline.replace('rootwait', 'rootwait modules-load=dwc2,g_ether');
        fs.writeFileSync(cmdlinePath, cmdline);
    }
}

async function detachDrive(bootPath: string) {
    const platform = os.platform();
    if (platform === 'darwin') {
        await execa('diskutil', ['unmount', bootPath]);
    } else if (platform === 'linux') {
        await execa('umount', [bootPath]);
    }
}

async function showMessage(
    screen: any,
    content: string,
    style: { fg: string; bg?: string } = { fg: 'green', bg: 'black' },
    duration = 1500,
) {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style,
        content,
        tags: true,
    });
    screen.append(box);
    screen.render();

    return new Promise<void>((rs) => {
        setTimeout(() => {
            box.destroy();
            screen.render();
            rs();
        }, duration);
    });
}

async function main() {
    program = blessed.program({
        smartCSR: true,
        title: 'Raspberry Pi Zero USB Setup',
    });

    screen = blessed.screen({
        smartCSR: true,
        title: 'Raspberry Pi Zero USB Setup',
        program,
    });

    screen.key(['C-c'], cleanup);

    const statusBox = blessed.box({
        bottom: 0,
        left: 0,
        width: '100%',
        height: 'shrink',
        content: '',
        tags: true,
        style: { fg: 'white' },
    });
    screen.append(statusBox);

    let steps = 0;
    const stepElements: blessed.Widgets.BoxElement[] = [];
    const step = (text: string) => {
        const prev = stepElements[steps - 1];
        const top = steps++;
        const box = blessed.box({
            top,
            left: 0,
            width: '100%',
            height: 'shrink',
            content: ` Step ${steps}. ${chalk.yellow(text)} `,
            tags: true,
            style: { fg: 'white' },
        });

        if (prev) {
            prev.setContent(prev.content + chalk.green(' Done. '));
        }

        screen.append(box);
        stepElements.push(box);
        screen.render();
    };
    const status = (text: string) => {
        statusBox.setContent(` ${chalk.gray(text)} `);
        screen.render();
    };

    screen.render();

    status('Ready.');
    step('Looking for boot drive...');
    const bootPath = await selectDrive(screen);

    if (bootPath) {
        step('Configuring boot drive at ${bootPath}...');
        await setupBootDrive(bootPath);
        await showMessage(screen, ' Boot configuration updated! ');

        step('Ejecting drive...');
        await detachDrive(bootPath);
        await showMessage(screen, ' Drive ejected! ');
    } else {
        status('Skipped boot drive setup.');
        await showMessage(screen, ' Skipped ', { fg: 'yellow', bg: 'black' });
    }

    step('Connect your Pi to this computer via USB...');
    await pause(screen, ' Connect Pi via USB, then press Enter... ');
    status('Waiting for USB...');

    const deviceName = await waitForUsb(screen);
    status(`Connected "${deviceName}"`);

    step('Waiting for Pi to respond...');
    status(`Connected "${deviceName}". Pinging...`);
    const host = await waitForPing(screen);

    step('Connecting via SSH...');
    status(`Connected "${deviceName}". Trying to connect via SSH...`);
    await trySsh(screen, host);

    status('Done!');

    setTimeout(cleanup, 3000);
}

main().catch((e) => {
    console.error(e);
    void cleanup();
});
