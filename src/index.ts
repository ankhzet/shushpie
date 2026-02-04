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

async function waitForUsb(screen: Widgets.Screen): Promise<string> {
    return showMessage({
        screen,
        content: 'Waiting for Raspberry Pi USB connection...\n\n (Connect Pi via USB cable)',
        style: { border: { fg: 'yellow' } },
        cb: () => waitForUsbConnection(),
    }).finally(() => pause(
        screen,
        `USB device connected\nWaiting to boot...`,
        30000,
    ));
}

async function searchUsb(screen: Widgets.Screen): Promise<string | null> {
    return selectFromList(
        screen,
        'Select Raspberry Pi USB device',
        'Raspberry Pi not found',
        async () => {
            const devices = await enumerateUsbDevices();

            return devices.map((value) => ({
                value,
                label: value,
            }));
        },
    );
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

async function trySsh(screen: Widgets.Screen, login: string): Promise<void> {
    return showMessage({
        screen,
        content: `SSH to ${login}...`,
        cb: async () => {
            try {
                await ssh(login, 'echo SSH OK');
            } catch {
                throw new Error('SSH failed. Check cable or wait longer.');
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

                if (stdout.includes('1b')) {
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
            } catch (e) {
                throw new Error(`Failed to configure DLP: ${(e as Error).message}`);
            }

            await pause(screen, `DLP configured for external DPI! Projector should lock to signal.`);
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

await makeProgram(async ({ screen }) => {
    const status = statusBox(screen);

    const step = steps(screen);

    screen.render();

    status.content('Ready.');
    step.next('Looking for boot drive...');
    const bootPath = await selectFromList(
        screen,
        'Select boot drive',
        'No removable drives found.',
        getRemovableDrives,
    );

    let configureDlp = false;

    if (bootPath) {
        configureDlp = await askYesNo(screen, ' Configure for DLPDLCR2000EVM\n (DPI + I²C on GPIO 23/24)? ');

        step.next('Configuring boot drive...');
        await setupBootDrive(bootPath, configureDlp);
        await showMessage({
            screen,
            content: configureDlp ? 'Boot + DLP config written!' : ' oot configuration updated!',
        });

        step.next('Ejecting drive...');
        await detachDrive(bootPath);
        await showMessage({ screen, content: 'Drive ejected!' });
    } else {
        status.content('Skipped boot drive setup.');
        await showMessage({ screen, content: 'Skipped', style: { fg: 'yellow', bg: 'black' } });
    }

    step.next('Connect your Pi to this computer via USB...');
    const shouldWait = await askYesNo(screen, ' Wait for USB? ');
    let deviceName;

    if (shouldWait) {
        status.content('Waiting for USB...');
        deviceName = await waitForUsb(screen);
        status.content(`Connected "${deviceName}", waiting to boot...`);
    } else {
        deviceName = (await searchUsb(screen)) || 'Unknown';
    }

    step.next('Waiting for Pi to respond...');
    status.content(`Pinging on "${deviceName}"...`);
    const host = await waitForPing(screen, ['fab.local', 'raspberrypi.local', '169.254.0.2']);
    const login = `pi@${host}`;

    step.next('Connecting via SSH...');
    status.content(`Successfully pinged "${host}". Trying to connect via SSH...`);
    await trySsh(screen, login);

    status.content(`Success! Pi is reachable over USB (${deviceName} -> ${login})!`);

    if (configureDlp) {
        step.next('Testing I²C (DLPC2607 at 0x1b)...');
        const i2cOk = await testI2cDevice(screen, login);

        status.content('I²C device 0x1b (DLPC2607) found!');

        if (i2cOk) {
            step.next('Configuring DLP for external DPI...');
            await configureDlpInput(screen, host);
        } else {
            throw new Error('I²C test failed.\n Check wiring and reboot Pi before retry.');
        }
    }

    status.content('Done!');
    await sleep(3000);
});
