import os from 'node:os';
import fs from 'node:fs';
import drivelist from 'drivelist';
import chalk from 'chalk';
import { usb, type Device } from 'usb';
import { execa, type Options } from 'execa';

import type { DpiTimings } from './types.js';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const ssh = async (host: string, commands: string | string[], options?: Options) => execa('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    host,
    Array.isArray(commands) ? commands.join('\n') : commands,
], options);

export type SSHResult = Record<'stdout' | 'stderr', string>;

export const testSSH = async ({ host, commands, test = (r) => !r.stderr, ...options }: Partial<Options> & {
    host: string;
    commands: string | string[];
    test?: (r: SSHResult) => boolean;
}): Promise<SSHResult & { success: boolean }> => {
    try {
        throw await ssh(host, commands, { encoding: 'utf8', ...options });
    } catch (e: any) {
        const result = ('stdout' in e) ? {
            stdout: e.stdout.toString(),
            stderr: e.stderr.toString(),
        } : {
            stdout: '',
            stderr: `${e.message || e}`,
        };

        return Object.assign(result, {
            success: test(result),
        });
    }
};

export const ping = (host: string) => execa('ping', ['-c', '1', '-W', '1', host]);

export const attachExit = () => {
    let isExiting = false;

    function cleanup() {
        usb.removeAllListeners();
    }

    async function interrupt() {
        if (isExiting) return;
        isExiting = true;

        console.log(chalk.gray('\n👋 Interrupted. Exiting gracefully.'));
        cleanup();
        process.exit(0);
    }

    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);

    return { cleanup, interrupt };
};

export async function detachDrive(bootPath: string) {
    const platform = os.platform();

    if (platform === 'darwin') {
        await execa('diskutil', ['unmount', bootPath]);
    } else if (platform === 'linux') {
        await execa('umount', [bootPath]);
    }
}

const DPI_TIMINGS = {
    h_sync_polarity: 0,
    h_front_porch: 14,
    h_sync_pulse: 4,
    h_back_porch: 12,
    v_sync_polarity: 0,
    v_front_porch: 2,
    v_sync_pulse: 3,
    v_back_porch: 9,
    v_sync_offset_a: 0,
    v_sync_offset_b: 0,
    pixel_rep: 0,
    interlaced: 0,
    aspect_ratio: 3,
};

export const dpiConfig = (
    h_active_pixels: number,
    v_active_lines: number,
    frame_rate: number,
): Record<string, unknown> => ({
    framebuffer_width: h_active_pixels,
    framebuffer_height: v_active_lines,
    framebuffer_depth: 16,
    max_framebuffers: 2,
    // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#enable_dpi_lcd
    enable_dpi_lcd: 1,
    // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#display_default_lcd
    display_default_lcd: 0,
    // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#dpi_group-dpi_mode-dpi_output_format
    dpi_group: 2,
    dpi_mode: 87,
    dpi_output_format: 458773,
    [`# ${h_active_pixels}x${v_active_lines} @ ~${frame_rate} Hz timings`]: '',
    // https://www.raspberrypi.com/documentation/computers/legacy_config_txt.html#dpi_timings
    dpi_timings: timings({
        ...DPI_TIMINGS,
        h_active_pixels,
        v_active_lines,
        frame_rate,
    }),
});

export const timings = ({
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

export const waitForUsbConnection = async (filter?: (deviceName?: string) => boolean) => {
    // @ts-ignore
    const { promise, resolve, reject } = Promise.withResolvers<string>();

    const handler = (device: Device) => {
        device.open();
        device.getStringDescriptor(device.deviceDescriptor.iProduct, async (err, value) => {
            if (filter && !filter(value?.trim())) {
                return;
            }

            if (err) {
                reject(err);
            } else {
                resolve(value?.trim() || 'Unknown device');
            }
        });
    };

    usb.addListener('attach', handler);

    try {
        return await promise;
    } finally {
        usb.removeListener('attach', handler);
    }
};

export const enumerateUsbDevices = () => Promise.all(
    usb.getDeviceList().map((device) => new Promise<string>((resolve, reject) => {
        device.open();
        device.getStringDescriptor(device.deviceDescriptor.iProduct, async (err, product) => {
            device.close();

            if (err) {
                reject(err);
            } else {
                resolve(product?.trim() || 'Unknown device');
            }
        });
    })),
);

export async function getRemovableDrives(): Promise<Array<{ value: string; label: string }>> {
    const drives = await drivelist.list();

    return (
        drives
            .filter((drive) => (
                drive.isRemovable
                && drive.mountpoints.length
                && !drive.mountpoints.some(p => p.path.includes('/Library/'))
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

export const updateFile = (pathname: string, cb: (content: string) => string) => {
    const content = fs.existsSync(pathname) ? fs.readFileSync(pathname, 'utf8') : '';
    let updated = content;

    try {
        updated = cb(content);
    } finally {
        if (content !== updated) {
            fs.writeFileSync(pathname, updated);
        }
    }
};
