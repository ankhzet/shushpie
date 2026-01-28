#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blessed from 'blessed';
import chalk from 'chalk';
import drivelist from 'drivelist';
import { usb } from 'usb';
import { execa } from 'execa';

let isExiting = false;
let screen: ReturnType<typeof blessed.screen>;
let program: ReturnType<typeof blessed.program>;

type DpiTimings = {
    h_active_pixels: number;
    h_sync_polarity: number;
    h_front_porch: number;
    h_sync_pulse: number;
    h_back_porch: number;
    v_active_lines: number;
    v_sync_polarity: number;
    v_front_porch: number;
    v_sync_pulse: number;
    v_back_porch: number;
    v_sync_offset_a: number;
    v_sync_offset_b: number;
    pixel_rep: number;
    frame_rate: number;
    interlaced: number;
    aspect_ratio: number;
}

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

async function getRemovableDrives(): Promise<Array<{ value: string; label: string }>> {
    const drives = await drivelist.list();

    return (
        drives
            .filter((drive) => (
                drive.isRemovable && !drive.mountpoints.some(p => p.path.includes('/Library/'))
            ))
            .map((drive) => {
                const paths = drive.mountpoints.map(p => p.path);

                return {
                    value: paths.find(p => /boot/i.test(p)) || paths[0],
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

type AsyncListItem = { label: string; value: string };

async function selectFromList(
    screen: blessed.Widgets.Screen,
    title: string,
    none: string,
    cb: () => Promise<AsyncListItem[]>,
): Promise<string | null> {
    return dialog(screen, async ({ container, submit }) => {
        const items = await cb();
        const total = items.length;

        container.append(blessed.box({
            top: 0,
            left: 0,
            width: '100%',
            height: 1,
            content: ` ${title} `,
            tags: true,
        }));

        if (total) {
            const list = blessed.list({
                top: 2,
                left: 0,
                height: total + 2,
                items: items.map(({ label }) => label),
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
                const selected = items[selectedIndex];

                if (selected) {
                    submit(selected.value);
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
            mssgBox(container, ` ${none} `);
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

async function selectDrive(screen: blessed.Widgets.Screen): Promise<string | null> {
    return selectFromList(
        screen,
        'Select boot drive',
        'No removable drives found.',
        () => getRemovableDrives(),
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

async function searchUsb(screen: ReturnType<typeof blessed.screen>): Promise<string | null> {
    return selectFromList(
        screen,
        'Select Raspberry Pi USB device',
        'Raspberry Pi not found',
        async () => Promise.all(usb.getDeviceList().map((device) => new Promise<AsyncListItem>((resolve, reject) => {
            device.open();
            device.getStringDescriptor(device.deviceDescriptor.iProduct, async (err, product) => {
                device.close();

                if (err) {
                    reject(err);
                } else {
                    const value = product?.trim() || 'Unknown device';

                    resolve({ value, label: value });
                }
            });
        }))),
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

async function testI2cDevice(screen: ReturnType<typeof blessed.screen>, host: string): Promise<boolean> {
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
        const { stdout } = await execa('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=5',
            `pi@${host}`,
            'sudo i2cdetect -y 3',
        ]);
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
            await new Promise(r => setTimeout(r, 2000));
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
            await new Promise(r => setTimeout(r, 3000));
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
        await new Promise(r => setTimeout(r, 3000));
        failed.destroy();
        return false;
    }
}

async function configureDlpInput(screen: ReturnType<typeof blessed.screen>, host: string): Promise<boolean> {
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
        await execa('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=5',
            `pi@${host}`,
            'sudo i2cset -y 3 0x1b 0x0c 0x00 0x00 0x00 0x13 i && sudo i2cset -y 3 0x1b 0x0b 0x00 0x00 0x00 0x00 i',
        ]);
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
        await new Promise(r => setTimeout(r, 2000));
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
        await new Promise(r => setTimeout(r, 3000));
        failed.destroy();
        return false;
    }
}

async function askYesNo(screen: ReturnType<typeof blessed.screen>, question: string): Promise<boolean> {
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

    container.append(blessed.box({
        content: question,
        tags: true,
    }));

    const btnYes = blessed.box({
        top: 2,
        left: 2,
        width: 10,
        height: 1,
        content: ' [ Yes ] ',
        style: { bg: 'blue', fg: 'white' },
    });
    const btnNo = blessed.box({
        top: 2,
        left: 15,
        width: 10,
        height: 1,
        content: ' [ No ] ',
        style: { fg: 'gray' },
    });
    container.append(btnYes);
    container.append(btnNo);

    screen.append(container);
    container.focus();
    screen.render();

    let resolved = false;

    return new Promise<boolean>((resolve) => {
        const doResolve = (value: boolean) => {
            if (resolved) return;

            resolved = true;
            container.destroy();
            screen.render();
            resolve(value);
        };

        container.key(['y', 'enter'], () => doResolve(true));
        container.key(['n', 'escape'], () => doResolve(false));
    });
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

        const timings = ({
            h_active_pixels,
            h_sync_polarity,
            h_front_porch,
            h_sync_pulse,
            h_back_porch,
            v_active_lines,
            v_sync_polarity,
            v_front_porch,
            v_sync_pulse,
            v_back_porch,
            v_sync_offset_a,
            v_sync_offset_b,
            pixel_rep,
            frame_rate,
            interlaced,
            aspect_ratio,
        }: DpiTimings) => {
            const pixel_freq = (
                (h_active_pixels + h_front_porch + h_sync_pulse + h_back_porch)
                * (v_active_lines + v_front_porch + v_sync_pulse + v_back_porch)
                * frame_rate
            );

            return [
                h_active_pixels,
                h_sync_polarity,
                h_front_porch,
                h_sync_pulse,
                h_back_porch,
                v_active_lines,
                v_sync_polarity,
                v_front_porch,
                v_sync_pulse,
                v_back_porch,
                v_sync_offset_a,
                v_sync_offset_b,
                pixel_rep,
                frame_rate,
                interlaced,
                pixel_freq,
                aspect_ratio,
            ].join(' ');
        };

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
        }

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
        await new Promise(r => setTimeout(r, 1000));
        status(`Waiting to boot...`);
        await new Promise(r => setTimeout(r, 29000));
    } else {
        deviceName = (await searchUsb(screen)) || 'Unknown';
    }

    step('Waiting for Pi to respond...');
    status(`Connected "${deviceName}". Pinging...`);
    const host = await waitForPing(screen, ['fab.local', 'raspberrypi.local', '169.254.0.2']);

    step('Connecting via SSH...');
    status(`Connected "${deviceName}". Trying to connect via SSH...`);
    await trySsh(screen, host);

    if (configureDlp) {
        step('Testing I²C (DLPC2607 at 0x1b)...');
        const i2cOk = await testI2cDevice(screen, host);

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

    setTimeout(cleanup, 3000);
}

main().catch((e) => {
    console.error(e);
    void cleanup();
});
