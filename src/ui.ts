import { Widgets, type BlessedProgram, box, screen, program, list } from 'blessed';
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

    const container = box({
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
    container.append(box({
        top: 2,
        left: 'center',
        content: message,
        style: { fg: 'yellow' },
    }));
    container.append(box({
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

        container.append(box({
            top: 0,
            left: 0,
            height: 1,
            content: ` ${title} `,
            tags: true,
        }));

        if (total) {
            const listEl = list({
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
            container.focus();
            container.append(listEl);

            container.append(box({
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
    const container = box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        keys: true,
        mouse: true,
    });

    const msg = box({
        left: 0,
        width: '100%',
        height: 'shrink',
        content: message,
        tags: true,
    });
    container.append(msg);

    const btn = box({
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
    const container = box({
        top: 'center',
        left: 'center',
        width: 'shrink',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        keys: true,
        mouse: true,
    });

    container.append(box({
        content: question,
        tags: true,
    }));

    const btnYes = box({
        top: 2,
        left: 2,
        width: 10,
        height: 1,
        content: ' [ Yes ] ',
        style: { bg: 'blue', fg: 'white' },
    });
    const btnNo = box({
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
    const boxEl = box({
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
        })
    } finally {
        boxEl.destroy();
        screen.render();
    }
}

export const makeProgram = async (fn: (handles: {
    screen: Widgets.Screen;
    program: BlessedProgram
}) => Promise<void>) => {
    const cleanup = attachExit();

    const main = async () => {
        const programEl = program({
            smartCSR: true,
            title: 'Raspberry Pi Zero USB Setup',
        });

        const screenEl = screen({
            smartCSR: true,
            title: 'Raspberry Pi Zero USB Setup',
            program: programEl,
        });

        screenEl.key(['C-c'], cleanup);

        try {
            await fn({
                program: programEl,
                screen: screenEl,
            });
        } catch (e: any) {
            await pause(
                screenEl,
                ` ${String(e.message || e)} \n\n Press Enter to continue... `,
            );

            throw e;
        } finally {
            screenEl.destroy();
            programEl.clear();
        }
    };

    return main().catch((e) => console.error(e)).finally(cleanup);
};

export const statusBox = (screen: Widgets.Screen) => {
    const statusBox = box({
        bottom: 0,
        left: 0,
        width: '100%',
        height: 'shrink',
        content: '',
        tags: true,
        style: { fg: 'white' },
    });
    screen.append(statusBox);

    return {
        content: (text: string) => {
            statusBox.setContent(` ${chalk.gray(text)} `);
            screen.render();
        },
        destroy: () => {
            statusBox.destroy();
            screen.render();
        },
    };
}

export const steps = (screen: Widgets.Screen, options?: { top: number; left: number }) => {
    let steps = 0;
    const stepElements: Widgets.BoxElement[] = [];
    const next = (text: string) => {
        const prev = stepElements[steps - 1];
        const top = steps++ + (options?.top || 0);
        const stepBox = box({
            top,
            left: (options?.left || 0),
            width: '100%',
            height: 'shrink',
            content: ` Step ${steps}. ${chalk.yellow(text)} `,
            tags: true,
            style: { fg: 'white' },
        });

        if (prev) {
            prev.setContent(prev.content + chalk.green(' Done. '));
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
}
