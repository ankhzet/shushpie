import blessed, { Widgets, type BlessedProgram } from 'blessed';
import { attachExit } from './utils.js';

type DialogOptions<T> = {
    container: Widgets.BoxElement;
    submit: (value: T | PromiseLike<T> | null) => void;
    close: () => void;
};

export const dialog = async <T>(
    screen: Widgets.Screen,
    cb: (options: DialogOptions<T>) => Promise<void>,
) => {
    // @ts-ignore
    const { promise, resolve } = Promise.withResolvers<T | null>();

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

const mssgBox = (container: Widgets.BoxElement, message: string) => {
    container.append(blessed.box({
        top: 2,
        left: 'center',
        content: message,
        style: { fg: 'yellow' },
    }));
    container.append(blessed.box({
        bottom: 0,
        left: 0,
        height: 1,
        content: ' Esc Cancel ',
        style: { fg: 'gray' },
    }));
};

type AsyncListItem = { label: string; value: string };

export async function selectFromList(
    screen: Widgets.Screen,
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

export async function pause(screen: ReturnType<typeof blessed.screen>, message: string): Promise<void> {
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

export async function askYesNo(screen: ReturnType<typeof blessed.screen>, question: string): Promise<boolean> {
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

export async function showMessage(
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

export const makeProgram = async (fn: (handles: { screen: Widgets.Screen; program: BlessedProgram }) => Promise<void>) => {
    const cleanup = attachExit();

    const main = async () => {
        const program = blessed.program({
            smartCSR: true,
            title: 'Raspberry Pi Zero USB Setup',
        });

        const screen = blessed.screen({
            smartCSR: true,
            title: 'Raspberry Pi Zero USB Setup',
            program,
        });

        screen.key(['C-c'], cleanup);

        try {
            await fn({
                program,
                screen,
            });
        } finally {
            screen.destroy();
            program.clear();
        }
    };

    return main().catch((e) => console.error(e)).finally(cleanup);
};
