#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import blessed from 'blessed';
import chalk from 'chalk';

import {
    waitForUsbConnection,
    getRemovableDrives,
    enumerateUsbDevices,
    sleep,
    ssh,
    timings,
    ping,
    detachDrive,
} from './utils.js';
import { selectFromList, askYesNo, pause, showMessage, makeProgram } from './ui.js';

async function selectDrive(screen: blessed.Widgets.Screen): Promise<string | null> {
    return selectFromList(
        screen,
        'Select boot drive',
        'No removable drives found.',
        getRemovableDrives,
    );
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

    const deviceName = await waitForUsbConnection();

    box.destroy();
    await showMessage(screen, ` USB device connected!\n ${deviceName} `);

    return deviceName;
}

async function searchUsb(screen: ReturnType<typeof blessed.screen>): Promise<string | null> {
    return selectFromList(
        screen,
        'Select Raspberry Pi USB device',
        'Raspberry Pi not found',
        async () => enumerateUsbDevices().then((devices) => devices.map((value) => ({ value, label: value }))),
    );
}

async function waitForPing(screen: ReturnType<typeof blessed.screen>, hostnames: string[]): Promise<string> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: '',
        tags: true,
    });
    screen.append(box);
    screen.render();

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
                await ping(currentHost);
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
                await sleep(1000);
                success.destroy();
                return currentHost;
            } catch {
                await sleep(1000);
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
    await sleep(2000);
    failed.destroy();

    throw new Error('Pi did not respond to ping.');
}

async function trySsh(screen: ReturnType<typeof blessed.screen>, login: string): Promise<void> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: ` SSH to ${login}... `,
        tags: true,
    });
    screen.append(box);
    screen.render();

    try {
        await ssh(login, 'echo SSH OK');

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

async function testI2cDevice(screen: ReturnType<typeof blessed.screen>, login: string): Promise<boolean> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: ` Testing I²C device at 0x1b... `,
        tags: true,
    });
    screen.append(box);
    screen.render();

    try {
        const { stdout } = await ssh(login, 'sudo i2cdetect -y 3');

        const hasDevice = stdout.includes('1b');
        box.destroy();

        if (hasDevice) {
            const success = blessed.box({
                top: 'center',
                left: 'center',
                width: 'shrink',
                height: 'shrink',
                border: { type: 'line' },
                style: { border: { fg: 'green' } },
                content: ' I²C device 0x1b (DLPC2607) found! ',
                tags: true,
            });
            screen.append(success);
            screen.render();
            await sleep(2000);
            success.destroy();
            return true;
        } else {
            const failed = blessed.box({
                top: 'center',
                left: 'center',
                width: 'shrink',
                height: 'shrink',
                border: { type: 'line' },
                style: { border: { fg: 'red' } },
                content: ' I²C device 0x1b not found.\n Check wiring and pull-ups. ',
                tags: true,
            });
            screen.append(failed);
            screen.render();
            await sleep(3000);
            failed.destroy();
            return false;
        }
    } catch (e) {
        box.destroy();
        const failed = blessed.box({
            top: 'center',
            left: 'center',
            width: 'shrink',
            height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'red' } },
            content: ` I²C test failed: ${(e as Error).message} `,
            tags: true,
        });
        screen.append(failed);
        screen.render();
        await sleep(3000);
        failed.destroy();
        return false;
    }
}

async function configureDlpInput(screen: ReturnType<typeof blessed.screen>, login: string): Promise<boolean> {
    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        content: ' Configuring DLP for external DPI input... ',
        tags: true,
    });
    screen.append(box);
    screen.render();

    try {
        await ssh(
            login,
            'sudo i2cset -y 3 0x1b 0x0c 0x00 0x00 0x00 0x13 i && sudo i2cset -y 3 0x1b 0x0b 0x00 0x00 0x00 0x00 i',
        );
        box.destroy();

        const success = blessed.box({
            top: 'center',
            left: 'center',
            width: 'shrink',
            height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'green' } },
            content: ' DLP configured for external DPI!\n Projector should lock to signal. ',
            tags: true,
        });
        screen.append(success);
        screen.render();
        await sleep(2000);
        success.destroy();
        return true;
    } catch (e) {
        box.destroy();
        const failed = blessed.box({
            top: 'center',
            left: 'center',
            width: 'shrink',
            height: 'shrink',
            border: { type: 'line' },
            style: { border: { fg: 'red' } },
            content: ` Failed to configure DLP: ${(e as Error).message} `,
            tags: true,
        });
        screen.append(failed);
        screen.render();
        await sleep(3000);
        failed.destroy();
        return false;
    }
}

async function setupBootDrive(bootPath: string, configureDlp = false) {
    const sshPath = path.join(bootPath, 'ssh');
    const configPath = path.join(bootPath, 'config.txt');
    const cmdlinePath = path.join(bootPath, 'cmdline.txt');

    fs.writeFileSync(sshPath, '');

    let cmdline = fs.readFileSync(cmdlinePath, 'utf8');

    if (!cmdline.includes('modules-load=dwc2,g_ether')) {
        cmdline = cmdline.replace('rootwait', 'rootwait modules-load=dwc2,g_ether');
        fs.writeFileSync(cmdlinePath, cmdline);
    }

    let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';

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

        const h_active_pixels = 854;
        const v_active_lines = 480;
        const frame_rate = 60;
        const dpi_timings = {
            h_active_pixels,
            h_sync_polarity: 0,
            h_front_porch: 14,
            h_sync_pulse: 4,
            h_back_porch: 12,
            v_active_lines,
            v_sync_polarity: 0,
            v_front_porch: 2,
            v_sync_pulse: 3,
            v_back_porch: 9,
            v_sync_offset_a: 0,
            v_sync_offset_b: 0,
            pixel_rep: 0,
            frame_rate,
            interlaced: 0,
            aspect_ratio: 3,
        };

        const dpiConfig = [
            `framebuffer_width=${h_active_pixels}`,
            `framebuffer_height=${v_active_lines}`,
            `framebuffer_depth=16`,
            'max_framebuffers=2',
            // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#enable_dpi_lcd
            'enable_dpi_lcd=1',
            // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#display_default_lcd
            'display_default_lcd=0',
            // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#dpi_group-dpi_mode-dpi_output_format
            'dpi_group=2',
            'dpi_mode=87',
            'dpi_output_format=458773',
            `# ${h_active_pixels}x${v_active_lines} @ ~${frame_rate} Hz timings`,
            // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#dpi_timings
            `dpi_timings=${timings(dpi_timings)}`,
            // 'overscan_left=0',
            // 'overscan_right=0',
            // 'overscan_top=0',
            // 'overscan_bottom=0',
            // // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#hdmi_ignore_edid
            // 'hdmi_ignore_edid=0xa5000080',
            // // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#config_hdmi_boost
            // 'config_hdmi_boost=5',
        ];

        for (const line of dpiConfig) {
            const key = line.split('=')[0];

            if (!config.includes(key + '=')) {
                config += '\n' + line;
            }
        }
    }
    fs.writeFileSync(configPath, config);
}

await makeProgram(async ({ screen }) => {
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

    let configureDlp = false;

    if (bootPath) {
        configureDlp = await askYesNo(screen, ' Configure for DLPDLCR2000EVM\n (DPI + I²C on GPIO 23/24)? ');

        step('Configuring boot drive...');
        await setupBootDrive(bootPath, configureDlp);
        await showMessage(screen, configureDlp ? ' Boot + DLP config written! ' : ' Boot configuration updated! ');

        step('Ejecting drive...');
        await detachDrive(bootPath);
        await showMessage(screen, ' Drive ejected! ');
    } else {
        status('Skipped boot drive setup.');
        await showMessage(screen, ' Skipped ', { fg: 'yellow', bg: 'black' });
    }

    step('Connect your Pi to this computer via USB...');
    const shouldWait = await askYesNo(screen, ' Wait for USB? ');
    let deviceName;

    if (shouldWait) {
        status('Waiting for USB...');
        deviceName = await waitForUsb(screen);
        status(`Connected "${deviceName}"`);
        await sleep(1000);
        status(`Waiting to boot...`);
        await sleep(29000);
    } else {
        deviceName = (await searchUsb(screen)) || 'Unknown';
    }

    step('Waiting for Pi to respond...');
    status(`Connected "${deviceName}". Pinging...`);
    const host = await waitForPing(screen, ['fab.local', 'raspberrypi.local', '169.254.0.2']);
    const login = `pi@${host}`;

    step('Connecting via SSH...');
    status(`Connected "${deviceName}". Trying to connect via SSH...`);
    await trySsh(screen, login);

    if (configureDlp) {
        step('Testing I²C (DLPC2607 at 0x1b)...');
        const i2cOk = await testI2cDevice(screen, login);

        if (i2cOk) {
            step('Configuring DLP for external DPI...');
            await configureDlpInput(screen, host);
        } else {
            step('Skipping DLP config (I²C test failed)');
            await pause(
                screen,
                ' I²C test failed.\n Check wiring and reboot Pi before retry.\n\n Press Enter to continue... ',
            );
        }
    }

    status('Done!');
    await sleep(3000);
});
