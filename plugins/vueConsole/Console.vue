<template>
    <div v-if="isOpen" class="console" @click="focusInput">
        <div class="console-output" ref="outputRef">
            <div
                v-for="(line, index) in outputLines"
                :key="index"
                :class="['output-line', line.type]"
            >
                {{ line.text }}
            </div>
        </div>
        <div class="console-input-row">
            <span class="prompt">&gt;</span>
            <div class="input-wrapper">
                <span v-if="currentArgHint" class="arg-hint">{{
                    currentArgHint
                }}</span>
                <input
                    ref="inputRef"
                    v-model="inputValue"
                    @keydown="handleKeydown"
                    @input="updateSuggestion"
                    type="text"
                    class="console-input"
                    autocomplete="off"
                    spellcheck="false"
                />
                <span class="autocomplete-ghost">{{ ghostText }}</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import {
    ReflectionKind,
    resolveReceiveType,
    typeOf,
    ReceiveType,
    ReflectionClass,
    Type,
    TypeFunction,
    TypeMethod,
    TypeUnion,
} from '@deepkit/type';

interface OutputLine {
    text: string;
    type: 'command' | 'log' | 'result' | 'error';
}

interface CommandDefinition {
    name: string;
    fn: (...args: any[]) => any;
    argTypes: ArgumentType[];
}

interface ArgumentType {
    name: string;
    type?: Type;
    optional: boolean;
    unionValues?: string[];
}

// Explicit command definition that can be passed in
export interface ExplicitCommandDef {
    fn: (...args: any[]) => any;
    args?: Array<{
        name: string;
        values?: string[]; // For union/enum autocomplete
        type?: 'string' | 'number' | 'boolean';
        optional?: boolean;
    }>;
}

export interface ConstructedMethodCommand {
    fn: (...args: any[]) => any;
    type: TypeFunction | TypeMethod;
}

const props = defineProps<{
    commands: Record<
        string,
        | ((...args: any[]) => any)
        | ConstructedMethodCommand
        | ExplicitCommandDef
    >;
}>();

const isOpen = ref(false);
const inputValue = ref('');
const outputLines = ref<OutputLine[]>([]);
const commandHistory = ref<string[]>([]);
const historyIndex = ref(-1);
const inputRef = ref<HTMLInputElement | null>(null);
const outputRef = ref<HTMLDivElement | null>(null);

let executing = false;

const originalLog = console.log;

console.log = (...args: []) => {
    originalLog(...args);

    if (!executing) return;
    const resultStr = args
        .map((result) =>
            typeof result === 'object'
                ? JSON.stringify(result, null, 2)
                : String(result)
        )
        .join(' ');

    outputLines.value.push({ text: resultStr, type: 'log' });
};

// Helper to check if command is explicit definition
function isExplicitDef(cmd: any): cmd is ExplicitCommandDef {
    return typeof cmd === 'object' && !('type' in cmd);
}

// Parse command definitions using deepkit reflection or explicit definitions
const commandDefinitions = computed<CommandDefinition[]>(() => {
    const defs: CommandDefinition[] = [];

    for (const [name, cmdOrFn] of Object.entries(props.commands)) {
        const argTypes: ArgumentType[] = [];
        let fn: (...args: any[]) => any;

        if (isExplicitDef(cmdOrFn)) {
            // Explicit definition with args
            fn = cmdOrFn.fn;
            if (cmdOrFn.args) {
                for (const arg of cmdOrFn.args) {
                    argTypes.push({
                        name: arg.name,
                        optional: arg.optional ?? false,
                        unionValues: arg.values,
                    });
                }
            }
        } else {
            // Plain function - try deepkit reflection
            fn = typeof cmdOrFn === 'function' ? cmdOrFn : cmdOrFn.fn;

            try {
                // Use deepkit to reflect on the function type
                const fnType =
                    typeof cmdOrFn === 'function'
                        ? (typeOf<typeof fn>() as TypeFunction | TypeMethod)
                        : cmdOrFn.type;

                if (
                    fnType &&
                    (fnType.kind === ReflectionKind.function ||
                        fnType.kind === ReflectionKind.method)
                ) {
                    for (const param of fnType.parameters) {
                        // Skip parameters with default values that look like internal (e.g., player = getCurrentPlayer())
                        // These typically have complex default expressions
                        if (param.default !== undefined) continue;

                        const argType: ArgumentType = {
                            name: param.name,
                            type: param.type,
                            optional:
                                param.optional || param.default !== undefined,
                        };

                        // Extract union literal values for autocomplete
                        if (param.type.kind === ReflectionKind.union) {
                            const unionType = param.type as TypeUnion;
                            const literals: string[] = [];
                            for (const t of unionType.types) {
                                if (
                                    t.kind === ReflectionKind.literal &&
                                    t.literal !== undefined
                                ) {
                                    literals.push(String(t.literal));
                                }
                            }
                            if (literals.length > 0) {
                                argType.unionValues = literals;
                            }
                        }

                        argTypes.push(argType);
                    }
                }
            } catch (e) {
                // If reflection fails, just register the command without arg info
            }
        }

        defs.push({ name, fn, argTypes });
    }

    console.log('[Console] definitions', defs);

    return defs;
});

const commandNames = computed(() =>
    commandDefinitions.value.map((d) => d.name)
);

// Parse current input into command and arguments
const parsedInput = computed(() => {
    const raw = inputValue.value;
    const trimmed = raw.trim();
    const parts = trimmed.split(/\s+/);
    const command = parts[0] || '';
    const args = parts.slice(1);
    const endsWithSpace = raw.endsWith(' ') && trimmed.length > 0;
    const isTypingArg = endsWithSpace || args.length > 0;
    const currentArgIndex = endsWithSpace
        ? args.length
        : Math.max(0, args.length - 1);
    const currentToken = endsWithSpace ? '' : args[args.length - 1] || command;
    const isTypingCommand = !isTypingArg && args.length === 0;

    // Calculate character offset where current token starts
    let currentTokenOffset = 0;
    if (isTypingCommand) {
        currentTokenOffset = 0;
    } else if (endsWithSpace) {
        currentTokenOffset = raw.length;
    } else if (args.length > 0) {
        currentTokenOffset = raw.lastIndexOf(args[args.length - 1]);
    }

    return {
        command,
        args,
        isTypingCommand,
        isTypingArg,
        currentArgIndex,
        currentToken,
        currentTokenOffset,
    };
});

// Get current command definition
const currentCommandDef = computed(() => {
    return commandDefinitions.value.find(
        (d) => d.name === parsedInput.value.command
    );
});

// Generate suggestions based on current input state
const suggestions = computed<string[]>(() => {
    const { command, isTypingCommand, currentArgIndex, currentToken } =
        parsedInput.value;

    if (isTypingCommand) {
        // Suggest command names
        return commandNames.value
            .filter((name) =>
                name.toLowerCase().startsWith(currentToken.toLowerCase())
            )
            .sort();
    }

    // Suggest argument values if we have union types
    const cmdDef = currentCommandDef.value;
    if (!cmdDef) return [];

    const argDef = cmdDef.argTypes[currentArgIndex];
    if (!argDef?.unionValues) return [];

    return argDef.unionValues
        .filter((val) =>
            val.toLowerCase().startsWith(currentToken.toLowerCase())
        )
        .sort();
});

// Ghost text for autocomplete preview
const ghostText = computed(() => {
    const { currentToken, isTypingCommand } = parsedInput.value;

    if (suggestions.value.length === 0) return '';

    const suggestion = suggestions.value[0];
    if (!suggestion.toLowerCase().startsWith(currentToken.toLowerCase()))
        return '';

    // Return the ghost text (what would be added)
    const prefix = inputValue.value;
    const completion = suggestion.slice(currentToken.length);

    return completion;
});

// Hint showing current argument name
const currentArgHint = computed(() => {
    const { isTypingCommand, currentArgIndex } = parsedInput.value;

    // Don't show hint while typing command name
    if (isTypingCommand) return '';

    const cmdDef = currentCommandDef.value;
    if (!cmdDef) return '';

    const argDef = cmdDef.argTypes[currentArgIndex];
    if (!argDef) return '';

    return argDef.name + (argDef.optional ? '?' : '');
});

function updateSuggestion() {
    // Triggered on input, suggestions are reactive
}

function completeWithTab() {
    if (suggestions.value.length === 0) return;

    const { currentToken, isTypingCommand, args, command } = parsedInput.value;
    const suggestion = suggestions.value[0];

    if (isTypingCommand) {
        inputValue.value = suggestion + ' ';
    } else {
        // Replace current argument with suggestion
        const newArgs = [...args];
        if (inputValue.value.endsWith(' ')) {
            newArgs.push(suggestion);
        } else {
            newArgs[newArgs.length - 1] = suggestion;
        }
        inputValue.value = command + ' ' + newArgs.join(' ') + ' ';
    }
}

function executeCommand() {
    const input = inputValue.value.trim();
    if (!input) return;

    // Add to history
    commandHistory.value.unshift(input);
    historyIndex.value = -1;

    // Log the command
    outputLines.value.push({ text: `> ${input}`, type: 'command' });

    const { command, args } = parsedInput.value;
    const cmdDef = commandDefinitions.value.find((d) => d.name === command);

    if (!cmdDef) {
        outputLines.value.push({
            text: `Unknown command: ${command}`,
            type: 'error',
        });
    } else {
        try {
            // Parse arguments based on their types
            const parsedArgs = args.map((arg, i) => {
                const argDef = cmdDef.argTypes[i];
                if (!argDef) return arg;

                // Try to parse as number if the type suggests it
                if (argDef.type.kind === ReflectionKind.number) {
                    return parseFloat(arg);
                }

                // Try to parse as boolean
                if (argDef.type.kind === ReflectionKind.boolean) {
                    return arg === 'true';
                }

                return arg;
            });

            executing = true;
            const result = cmdDef.fn(...parsedArgs);
            executing = false;

            if (result !== undefined) {
                const resultStr =
                    typeof result === 'object'
                        ? JSON.stringify(result, null, 2)
                        : String(result);
                outputLines.value.push({ text: resultStr, type: 'result' });
            } else {
                outputLines.value.push({ text: 'OK', type: 'result' });
            }
        } catch (e) {
            executing = false;
            outputLines.value.push({
                text: `Error: ${e instanceof Error ? e.message : String(e)}`,
                type: 'error',
            });
            console.error(e);
        }
    }

    inputValue.value = '';

    // Scroll to bottom
    nextTick(() => {
        if (outputRef.value) {
            outputRef.value.scrollTop = outputRef.value.scrollHeight;
        }
    });
}

function handleKeydown(e: KeyboardEvent) {
    if (isOpen.value) {
        e.stopImmediatePropagation();
    }

    if (e.ctrlKey && (e.key === '`' || e.key === '~')) {
        isOpen.value = false;
        return;
    } else if (e.key === 'Tab') {
        e.preventDefault();
        completeWithTab();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        executeCommand();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (historyIndex.value < commandHistory.value.length - 1) {
            historyIndex.value++;
            inputValue.value = commandHistory.value[historyIndex.value];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex.value > 0) {
            historyIndex.value--;
            inputValue.value = commandHistory.value[historyIndex.value];
        } else if (historyIndex.value === 0) {
            historyIndex.value = -1;
            inputValue.value = '';
        }
    } else if (e.key === 'Escape') {
        isOpen.value = false;
    }
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && (e.key === '`' || e.key === '~')) {
        e.preventDefault();
        isOpen.value = !isOpen.value;

        if (isOpen.value) {
            nextTick(() => {
                inputRef.value?.focus();
            });
        }
    }
}

function focusInput() {
    inputRef.value?.focus();
}

// Watch for console open to focus input
watch(isOpen, (open) => {
    if (open) {
        nextTick(() => {
            inputRef.value?.focus();
        });
    }
});

onMounted(() => {
    window.addEventListener('keydown', handleGlobalKeydown);
});

onUnmounted(() => {
    window.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<style lang="scss" scoped>
.console {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 40vh;
    background: rgba(0, 0, 0, 0.9);
    border-bottom: 2px solid #444;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 14px;
    color: #ddd;
    display: flex;
    flex-direction: column;
    z-index: 9999;
    animation: slideDown 0.15s ease-out;

    pointer-events: all;
}

@keyframes slideDown {
    from {
        transform: translateY(-100%);
    }
    to {
        transform: translateY(0);
    }
}

.console-output {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;

    &::-webkit-scrollbar {
        width: 8px;
    }

    &::-webkit-scrollbar-track {
        background: #1a1a1a;
    }

    &::-webkit-scrollbar-thumb {
        background: #444;
        border-radius: 4px;
    }
}

.output-line {
    padding: 2px 0;
    white-space: pre-wrap;
    word-break: break-all;

    &.command {
        color: #efefef;
    }

    &.result {
        color: #8f8;
    }
    &.log {
        color: #adadad;
    }

    &.error {
        color: #f88;
    }
}

.console-input-row {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.5);
    border-top: 1px solid #333;
}

.prompt {
    color: #8f8;
    margin-right: 8px;
    font-weight: bold;
}

.input-wrapper {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
}

.arg-hint {
    position: absolute;
    bottom: 100%;
    left: v-bind('2 + parsedInput.currentTokenOffset + "ch"');
    padding: 2px 6px;
    margin-bottom: 2px;
    background: rgba(50, 50, 50, 0.95);
    border: 1px solid #555;
    border-radius: 3px;
    color: #aaa;
    font-size: 12px;
    pointer-events: none;
    white-space: nowrap;
}

.console-input {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    color: #fff;
    font-family: inherit;
    font-size: inherit;
    caret-color: #8f8;

    &::placeholder {
        color: #555;
    }
}

.autocomplete-ghost {
    position: absolute;
    left: 0;
    pointer-events: none;
    color: #555;
    white-space: pre;
    // Position after the input text
    padding-left: v-bind('inputValue.length + "ch"');
}
</style>
