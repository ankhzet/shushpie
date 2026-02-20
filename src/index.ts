#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { Widgets } from 'blessed';

import {
    waitForUsbConnection,
    getRemovableDrives,
    enumerateUsbDevices,
    sleep,
    ssh,
    ping,
    detachDrive,
    dpiConfig,
    updateFile,
} from './utils.js';
import { selectFromList, askYesNo, showMessage, makeProgram, pause, statusBox, steps } from './ui.js';

async function waitForUsb(screen: Widgets.Screen): Promise<string | null> {
    const shouldWait = await askYesNo(screen, ' Wait for USB? ');

    if (shouldWait) {
        return showMessage({
            screen,
            content: 'Waiting for Raspberry Pi USB connection...\n\n (Connect Pi via USB cable)',
            style: { border: { fg: 'yellow' } },
            cb: async () => {
                const deviceName = await waitForUsbConnection();

                await pause(
                    screen,
                    `USB device connected:\n\t${deviceName}\nWaiting to boot...`,
                    30000,
                );

                return deviceName;
            },
        });
    }

    return selectFromList({
        screen,
        title: 'Select Raspberry Pi USB device',
        none: 'Raspberry Pi not found',
        cb: async () => {
            const devices = await enumerateUsbDevices();

            return devices.map((value) => ({
                value,
                label: value,
            }));
        },
    });
}

async function waitForPing(screen: Widgets.Screen, hostnames: string[]): Promise<string> {
    return showMessage({
        screen,
        content: '',
        cb: async (_, content): Promise<string> => {
            for (let i = 0; i < hostnames.length; i++) {
                const currentHost = hostnames[i];

                if (i > 0) {
                    content(chalk.red(`Ping failed. Trying ${currentHost}...`));
                }

                for (let attempt = 1; attempt <= 15; attempt++) {
                    content(` Pinging ${currentHost}... (${attempt}/15) `);

                    try {
                        return (await ping(currentHost), currentHost);
                    } catch {
                        await sleep(1000);
                    }
                }
            }

            throw new Error('Pi did not respond to ping.');
        },
    });
}

async function trySsh(screen: Widgets.Screen, host: string, users: string[]): Promise<string | undefined> {
    return showMessage({
        screen,
        content: `SSH to ${host}...`,
        cb: async () => {
            for (const user of users) {
                const login = `${user}@${host}`;

                try {
                    await ssh(login, 'echo SSH OK');

                    return login;
                } catch {
                    //
                }
            }
        },
    });
}

async function testI2cDevice(screen: Widgets.Screen, login: string): Promise<boolean> {
    return showMessage({
        screen,
        content: 'Testing I²C device at 0x1b...',
        style: { border: { fg: 'cyan' } },
        cb: async () => {
            try {
                const { stdout } = await ssh(login, 'sudo i2cdetect -y 3');

                if (stdout!.toString().includes('1b')) {
                    return true;
                }

                throw new Error(`I²C device 0x1b not found.\n Check wiring and pull-ups.`);
            } catch (e) {
                throw new Error(`I²C test failed: ${(e as Error).message}`);
            }
        },
    });
}

async function configureDlpInput(screen: Widgets.Screen, login: string) {
    return showMessage({
        screen,
        content: 'Configuring DLP for external DPI input...',
        style: { border: { fg: 'cyan' } },
        cb: async () => {
            try {
                await ssh(
                    login,
                    'sudo i2cset -y 3 0x1b 0x0c 0x00 0x00 0x00 0x13 i && sudo i2cset -y 3 0x1b 0x0b 0x00 0x00 0x00 0x00 i',
                );

                return true;
            } catch (e) {
                throw new Error(`Failed to configure DLP: ${(e as Error).message}`);
            }
        },
    });
}

async function setupBootDrive(bootPath: string, configureDlp = false) {
    const sshPath = path.join(bootPath, 'ssh');
    const configPath = path.join(bootPath, 'config.txt');
    const cmdlinePath = path.join(bootPath, 'cmdline.txt');

    fs.writeFileSync(sshPath, '');

    updateFile(cmdlinePath, (cmdline) => {
        if (!cmdline.includes('modules-load=dwc2,g_ether')) {
            cmdline = cmdline.replace('rootwait', 'rootwait modules-load=dwc2,g_ether');
        }

        return cmdline;
    });

    updateFile(configPath, (config) => {
        if (!config.includes('dtoverlay=dwc2')) {
            config += '\n\n# --- NCM USB Gadget ---\ndtoverlay=dwc2\n';
        }

        if (configureDlp) {
            if (!config.includes('dtoverlay=i2c-gpio')) {
                config += '\n\n# --- Software I2C for DLPC2607 ---\ndtoverlay=i2c-gpio,i2c_gpio_sda=23,i2c_gpio_scl=24,i2c_gpio_delay_us=2\n';
            }

            if (!config.includes('dtoverlay=dpi18')) {
                config += '\n# --- DPI output for DLPDLCR2000EVM (off-screen) ---\ndtoverlay=dpi18\n';
            }

            const dpiConfigLines = dpiConfig(854, 480, 60);

            for (const [key, value] of Object.entries(dpiConfigLines)) {
                if (!config.includes(key + '=')) {
                    config += '\n' + [key, value].filter((v) => (v ?? '') !== '').join('=');
                }
            }
        }

        return config;
    });
}

await makeProgram('Raspberry Pi Zero USB Setup', async ({ screen }) => {
    const status = statusBox(screen);
    const step = steps(screen);

    screen.render();

    const state: {
        bootPath: string | null;
        ejected: boolean;
        configureDlp: boolean;
        dlpOk: boolean;
        i2cOk: boolean;
        deviceName: string | null;
        host: string;
        login?: string;
    } = {
        bootPath: '',
        deviceName: '',
        host: '',
        login: '',
        ejected: false,
        configureDlp: false,
        dlpOk: false,
        i2cOk: false,
    };

    const updateState = (update: Partial<typeof state>) => {
        Object.assign(state, update);

        status.content([
            state.configureDlp ? (state.dlpOk ? chalk.green(`DLP`) : chalk.yellow(`DLP`)) : chalk.gray(`DLP`),
            state.login ? chalk.green(`SSH`) : chalk.gray(`SSH`),
            state.i2cOk ? chalk.green(`I²C`) : chalk.gray(`I²C`),
            `Media: ${state.bootPath ? (state.ejected ? chalk.gray(state.bootPath) : chalk.green(state.bootPath)) : '?'}`,
            `USB: ${state.deviceName ? chalk.green(state.deviceName) : '?'}`,
            `Host: ${state.host ? chalk.green(state.host) : '?'}`,
            `User: ${state.login ? chalk.green(state.login) : '?'}`,
        ].join(' | '));
    };

    updateState({});

    step.next('Looking for boot drive...');
    updateState({
        bootPath: await selectFromList({
            screen,
            title: 'Select boot drive',
            none: 'No removable drives found.',
            cb: getRemovableDrives,
        }),
    });

    if (state.bootPath) {
        updateState({
            configureDlp: await askYesNo(screen, ' Configure for DLPDLCR2000EVM\n (DPI + I²C on GPIO 23/24)? '),
        });

        step.next(`Configuring Boot drive...`);
        await setupBootDrive(state.bootPath, state.configureDlp);

        step.next('Ejecting drive...');
        await detachDrive(state.bootPath);
        updateState({
            ejected: true,
        })
    }

    step.next('Connect your Pi to this computer via USB...');
    updateState({
        deviceName: await waitForUsb(screen).then((v) => v || 'Unknown'),
    });

    step.next('Waiting for Pi to respond...');
    updateState({
        host: await waitForPing(screen, ['fab.local', 'raspberrypi.local', '169.254.0.2']),
    });

    step.next('Connecting via SSH...');
    updateState({
        login: await trySsh(screen, state.host, ['pi', 'fab']),
    });

    if (state.configureDlp && state.login) {
        step.next('Testing I²C (DLPC2607 at 0x1b)...');
        updateState({
            i2cOk: await testI2cDevice(screen, state.login),
        });

        step.next('Configuring DLP for external DPI...');
        updateState({
            dlpOk: await configureDlpInput(screen, state.login),
        });
    }

    await pause(screen, `Done.`, 3000);
});
