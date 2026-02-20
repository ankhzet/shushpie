import blessed, { Widgets, type BlessedProgram } from 'blessed';
import { attachExit, sleep } from './utils.js';
import chalk from 'chalk';

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

export async function selectFromList({ screen, title, none = '', cb }: {
    screen: Widgets.Screen,
    title: string,
    none?: string,
    cb: () => Promise<AsyncListItem[]>,
}): Promise<string | null> {
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

        container.focus();

        if (total) {
            const listEl = blessed.list({
                top: 2,
                left: 0,
                height: total + 2,
                items: items.map(({ label }) => label),
                style: {
                    selected: { bg: 'blue', fg: 'white' },
                    item: { fg: 'white' },
                },
            });
            listEl.select(0);
            container.append(listEl);

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
                listEl.select(selectedIndex);
                screen.render();
            });

            container.key(['down', 'j', 'n'], () => {
                selectedIndex = (selectedIndex + total + 1) % total;
                listEl.select(selectedIndex);
                screen.render();
            });
        } else {
            mssgBox(container, ` ${none} `);
        }
    });
}

export async function pause(screen: Widgets.Screen, message: string, closeAfter?: number): Promise<void> {
    const container = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        keys: true,
        mouse: true,
    });

    const msg = blessed.box({
        width: '100%',
        height: '100%',
        top: 'center',
        left: 'center',
        content: message,
        padding: 1,
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        tags: true,
    });
    container.append(msg);

    const btn = blessed.box({
        bottom: 0,
        left: 'center',
        width: 'shrink',
        height: 1,
        content: ' [ Press Enter to continue ] ',
        style: { bg: 'blue', fg: 'white', bold: true },
    });
    container.append(btn);

    screen.append(container);
    screen.render();
    container.focus();

    // @ts-ignore
    const { promise, resolve } = Promise.withResolvers<void>();

    container.key(['enter', 'return', 'space', 'escape', 'q', 'C-c'], resolve);

    if (closeAfter) {
        setTimeout(resolve, closeAfter);
    }

    return promise.finally(() => {
        container.destroy();
        screen.render();
    });
}

export async function askYesNo(screen: Widgets.Screen, question: string): Promise<boolean> {
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

export async function showMessage<T = void>({
    screen,
    content,
    style = { fg: 'green', bg: 'black' },
    duration,
    cb,
}: {
    screen: any;
    content: string;
    style?: any;
} & ({ duration?: number; cb?: never } | {
    cb?: (el: Widgets.BoxElement, content: (c: string) => void) => Promise<T>;
    duration?: never
})): Promise<T> {
    const boxEl = blessed.box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style,
        content: content && ` ${content} `,
        tags: true,
    });
    screen.append(boxEl);
    screen.render();

    try {
        if (duration ?? false) {
            cb = () => sleep(duration!) as Promise<T>;
        }

        return await cb!(boxEl, (content) => {
            boxEl.setContent(content && ` ${content} `);
            screen.render();
        });
    } finally {
        boxEl.destroy();
        screen.render();
    }
}

export const makeProgram = async (title: string, fn: (handles: {
    screen: Widgets.Screen;
    program: BlessedProgram
}) => Promise<void | unknown>) => {
    const { cleanup, interrupt } = attachExit();

    const main = async () => {
        const program = blessed.program({
            smartCSR: true,
            title,
        });

        const screen = blessed.screen({
            smartCSR: true,
            title,
            program,
        });

        screen.key(['C-c'], interrupt);

        try {
            await fn({
                program,
                screen,
            });
        } catch (e: any) {
            await pause(
                screen,
                ` ${String(e.message || e)} \n\n Press Enter to continue... `,
            );

            throw e;
        } finally {
            screen.destroy();
            program.clear();
        }
    };

    return main().catch((e) => console.error(e)).finally(cleanup);
};

export const statusBox = (
    screen: Widgets.Screen,
    { dull = true, content: init, ...rest }: Partial<Widgets.BoxOptions> & { dull?: boolean } = {},
) => {
    const box = blessed.box({
        bottom: 0,
        left: 0,
        width: '100%',
        height: 'shrink',
        content: '',
        tags: true,
        style: { fg: 'white' },
        shrink: true,
        ...rest,
    });
    screen.append(box);

    const content = (text: string) => {
        box.setContent(`[ ${dull ? chalk.gray(text) : text} ]`);
        screen.render();
    };
    const preserve = async <T = void>(cb: () => T | Promise<T>) => {
        const current = box.getContent();

        try {
            return await cb();
        } finally {
            box.setContent(current);
            screen.render();
        }
    };

    if (init) {
        content(init);
    }

    return {
        content,
        preserve,
        destroy: () => {
            box.destroy();
            screen.render();
        },
    };
};

export const steps = (screen: Widgets.Screen, options?: { top: number; left: number }) => {
    let steps = 0;
    const stepElements: Widgets.BoxElement[] = [];
    const next = (text: string, ammend?: string) => {
        const prev = stepElements[steps - 1];
        const top = steps++ + (options?.top || 0);
        const stepBox = blessed.box({
            top,
            left: (options?.left || 0),
            width: '100%',
            height: 'shrink',
            content: ` Step ${steps}. ${chalk.yellow(text)} `,
            tags: true,
            style: { fg: 'white' },
        });

        if (prev) {
            prev.setContent(prev.content + (ammend ?? chalk.green(' Done. ')));
        }

        screen.append(stepBox);
        stepElements.push(stepBox);
        screen.render();
    };

    return {
        next,
        destroy: () => {
            for (const el of stepElements) {
                el.destroy();
            }

            screen.render();
        },
    };
};
