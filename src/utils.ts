import os from 'node:os';
import drivelist from 'drivelist';
import chalk from 'chalk';
import { usb, type Device } from 'usb';
import { execa } from 'execa';

import type { DpiTimings } from './types.js';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const ssh = async (host: string, commands: string) => execa('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    host,
    commands,
]);

export const ping = (host: string) => execa('ping', ['-c', '1', '-W', '1', host]);

export const attachExit = () => {
    let isExiting = false;

    async function cleanup() {
        if (isExiting) return;
        isExiting = true;

        usb.removeAllListeners();
        console.log(chalk.gray('\n👋 Interrupted. Exiting gracefully.'));
        process.exit(0);
    }

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    return cleanup;
}

export async function detachDrive(bootPath: string) {
    const platform = os.platform();

    if (platform === 'darwin') {
        await execa('diskutil', ['unmount', bootPath]);
    } else if (platform === 'linux') {
        await execa('umount', [bootPath]);
    }
}

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
