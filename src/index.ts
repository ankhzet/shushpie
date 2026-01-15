#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import inquirer from 'inquirer';
import usbDetection from 'usb-detection';
import chalk from 'chalk';
import { execa } from 'execa';
import { program } from 'commander';
import drivelist from 'drivelist';

let isExiting = false;

async function cleanup() {
    if (isExiting) return;
    isExiting = true;
    usbDetection.stopMonitoring();
    console.log(chalk.gray('\n\n👋 Interrupted. Exiting gracefully.'));
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

program
    .name('rpi-zero-usb-setup')
    .description('Step-by-step USB SSH setup for Raspberry Pi Zero')
    .version('0.1.0');

program.parse(process.argv);

async function log(step: string, msg: any) {
    console.log(chalk.cyan(`\n[${step}]`), msg);
}

async function pause(msg = 'Press enter to continue...') {
    await inquirer.prompt({ type: 'confirm',  name: 'ok', message: msg });
}

/**
 * STEP 1: Look for a connected boot drive
 */
async function findBootDrive() {
    await log('1', 'Looking for Raspberry Pi boot partition...');

    const skip = 'None - skip boot drive setup';

    try {
        const drives = await drivelist.list();
        const removable = drives.filter((d) => d.isRemovable && !d.mountpoints.some((p) => p.path.includes('/Library/')));

        if (removable.length === 0) {
            console.log(chalk.yellow('No removable drives found.'));
            return null;
        }


        const candidates = removable.map(d => {
            const parts = d.mountpoints.map(p => p.path).join(', ') || 'No mountpoint';

            return {
                name: `${d.device} (${d.description || 'Unknown'}) - ${parts}`,
                value: d.mountpoints.map(p => p.path).find(p => /boot/i.test(p)) || d.mountpoints[0]?.path,
            };
        });

        const { selectedDrive = null } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedDrive',
                message: 'Select boot drive:',
                choices: [
                    ...candidates.map(c => ({ name: c.name, value: c.value })),
                    new inquirer.Separator(),
                    skip,
                ],
            },
        ]);

        return (
            (!selectedDrive || (selectedDrive === skip))
                ? null
                : selectedDrive
        );
    } catch {
        console.log(chalk.yellow('Could not detect drives automatically.'));
    }

    const { drive } = await inquirer.prompt({
        type: 'input',
        name: 'drive',
        message: 'Enter boot drive path:',
    });

    return drive || null;
}

/**
 * STEP 2: Perform basic setup on boot partition
 */
async function setupBootDrive(bootPath: string) {
    await log('2', `Configuring boot drive at ${bootPath}`);

    const sshPath = path.join(bootPath, 'ssh');
    const configPath = path.join(bootPath, 'config.txt');
    const cmdlinePath = path.join(bootPath, 'cmdline.txt');

    // Enable SSH
    fs.writeFileSync(sshPath, '');

    // Add dtoverlay if missing
    let config = fs.existsSync(configPath)
        ? fs.readFileSync(configPath, 'utf8')
        : '';

    if (!config.includes('dtoverlay=dwc2')) {
        config += '\n\ndtoverlay=dwc2\n';
        fs.writeFileSync(configPath, config);
    }

    // Patch cmdline.txt
    let cmdline = fs.readFileSync(cmdlinePath, 'utf8');

    if (!cmdline.includes('modules-load=dwc2,g_ether')) {
        cmdline = cmdline.replace(
            'rootwait',
            'rootwait modules-load=dwc2,g_ether',
        );
        fs.writeFileSync(cmdlinePath, cmdline);
    }

    console.log(chalk.green('✔ Boot configuration updated.'));
}

/**
 * STEP 3: Ask to detach drive
 */
async function detachDrive(bootPath: string) {
    await log('3', 'Safely eject the boot drive');

    const platform = os.platform();

    if (platform === 'darwin') {
        await execa('diskutil', ['unmount', bootPath]);
    } else if (platform === 'linux') {
        await execa('umount', [bootPath]);
    } else {
        console.log(chalk.yellow('Please eject the drive manually.'));
    }

    console.log(chalk.green('✔ Drive detached.'));
}

/**
 * STEP 5: Wait for USB device
 */
async function waitForUsbDevice() {
    await log('5', 'Waiting for Raspberry Pi to be connected via USB...');

    usbDetection.startMonitoring();

    await new Promise<void>((resolve) => {
        usbDetection.on('add', (device) => {
            console.log(chalk.gray('USB device connected:', device.deviceName || device.productId));

            resolve();
        });
    });

    usbDetection.stopMonitoring();
}

/**
 * STEP 6: Try to ping
 */
async function waitForPing(host = 'raspberrypi.local', attempts = 15) {
    await log('6', `Pinging ${host}...`);

    for (const hostname of [host, '169.254.0.2']) {
        if (hostname !== host) {
            console.log(chalk.red(`Ping failed. Trying fallback ${hostname}`));
        }

        for (let i = 0; i < attempts; i++) {
            try {
                await execa('ping', ['-c', '1', '-W', '1', hostname]);
                console.log(chalk.green(`✔ ${hostname} is reachable!`));
                return hostname;
            } catch {
                console.log(chalk.gray(`... not yet (${i + 1}/${attempts})`));
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    throw new Error('Pi did not respond to ping.');
}

/**
 * STEP 7: Try SSH
 */
async function trySsh(host: string) {
    await log('7', `Trying SSH to pi@${host}`);

    try {
        await execa('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=5',
            `pi@${host}`,
            'echo \'SSH OK\'',
        ], { stdio: 'inherit' });

        console.log(chalk.green('\n🎉 Success! Your Pi is reachable over USB.'));
    } catch {
        console.log(chalk.red('SSH failed. You may need to wait a bit longer or check the cable.'));
    }
}

try {
    console.log(chalk.bold('\n🚀 Raspberry Pi Zero USB Setup Wizard\n'));

    // Step 1
    let bootPath = await findBootDrive();

    if (!bootPath) {
        console.log(chalk.yellow('Skipping boot drive setup.'));
    } else {
        // Step 2
        await setupBootDrive(bootPath);

        // Step 3
        await detachDrive(bootPath);
    }

    // Step 4
    await log('4', 'Now connect your Raspberry Pi Zero to this computer via the USB port.');
    await pause('Plug it in, then press Enter...');

    // Step 5
    await waitForUsbDevice();

    // Step 6
    const host = await waitForPing();

    // Step 7
    await trySsh(host);
} catch (e) {
    if (!String(e).includes('SIGINT')) {
        throw e;
    }
}
